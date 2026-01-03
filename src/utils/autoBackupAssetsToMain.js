import { PrismaClient } from '@prisma/client'
import { decryptToJson } from './cryptoUtils.js'
import { withMegaLock } from './megaQueue.js'
import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { log } from './logger.js'

/*
  Script: validateAssetsOnLastAccount (FINAL V3 - ZOMBIE KILLER EDITION)
  Mejoras:
    - Reinicio forzoso del servidor MEGA si hay errores (fix "login in progress").
    - Autenticación de proxy mediante flags separadas (--username/--password).
    - Timeout robusto y manejo de errores crítico.
*/

const prisma = new PrismaClient()
const UPLOADS_DIR = path.resolve('uploads')
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive:true })
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480
const UPLOADS_ACTIVE_FLAG = process.env.UPLOADS_ACTIVE_FLAG || path.join(UPLOADS_DIR, 'sync-cache', 'uploads-active.lock')

function uploadsAreActiveNow(){
  try {
    const st = fs.existsSync(UPLOADS_ACTIVE_FLAG) ? fs.statSync(UPLOADS_ACTIVE_FLAG) : null;
    if (!st) return false;
    const ageMin = (Date.now() - st.mtimeMs) / 60000;
    const maxIdleMin = process.env.UPLOADS_ACTIVE_MAX_IDLE_MIN ? Number(process.env.UPLOADS_ACTIVE_MAX_IDLE_MIN) : 60;
    return ageMin < maxIdleMin;
  } catch {
    return false;
  }
}

// Si hay subidas activas, NO debemos tocar la sesión global de MEGAcmd.
async function safeMegaLogout(ctx, why = ''){
  if (uploadsAreActiveNow()) {
    log.warn(`[MEGA][LOGOUT][SKIP] subidas activas. ${why ? `why=${why} ` : ''}${ctx || ''}`.trim());
    return;
  }
  return megaLogout(ctx);
}

async function safeClearProxy(why = ''){
  if (uploadsAreActiveNow()) {
    log.warn(`[PROXY][CLEAR][SKIP] subidas activas.${why ? ` why=${why}` : ''}`);
    return;
  }
  return clearProxy();
}

// ==========================================
// SISTEMA DE PROXIES
// ==========================================
const PROXY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxies.txt');
let PROXY_LIST = [];
let CURRENT_PROXY = null;
const PROXY_CURL_TEST_URL = 'https://www.google.com';
const PROXY_CURL_TIMEOUT_S = 10;
const STICKY_PROXY_ENABLED = true; // sticky por cuenta durante TODO el run
const STICKY_PROXY_MAX_TRIES = 5;  // cuántos proxies probar al asignar
const STICKY_PROXY_REFRESH_ON_LOGIN_FAIL = true; // si falla login, reintenta reasignando proxy

// Cache en memoria: accountKey -> { raw, proxyUrl } donde raw es línea IP:PORT:USER:PASS o null (direct)
const STICKY_PROXY_BY_ACCOUNT = new Map();

try {
  if (fs.existsSync(PROXY_FILE)) {
    const content = fs.readFileSync(PROXY_FILE, 'utf-8');
    // Guardamos las líneas crudas, las procesamos al momento de usar
    PROXY_LIST = content.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    log.info(`[INIT] Proxies cargados: ${PROXY_LIST.length}`);
  } else {
    log.warn('[INIT] NO se encontró proxies.txt. Se usará IP DIRECTA.');
  }
} catch (e) {
  log.error(`[INIT] Error leyendo proxies: ${e.message}`);
}

// Función para reiniciar el servidor si se queda "tonto"
async function resetMegaServer() {
  if (uploadsAreActiveNow()) {
    log.warn('[MEGA] Reinicio de servidor MEGA BLOQUEADO: hay subidas activas (uploads-active.lock).');
    return;
  }
  log.warn('[MEGA] Ejecutando reinicio de emergencia del servidor MEGA...');
  try {
    try { await runCmd('mega-quit', [], { quiet: true, timeoutMs: 5000 }); } catch {}
    try { execSync('pkill -9 -f mega-cmd-server'); } catch {} // Matar a la fuerza
    await sleep(5000); // Esperar que el SO libere recursos
    // Al ejecutar version, el server arranca solo
    try { await runCmd('mega-version', [], { quiet: true, timeoutMs: 10000 }); } catch {}
    log.info('[MEGA] Servidor reiniciado correctamente.');
  } catch (e) {
    log.error(`[MEGA] Fallo al reiniciar servidor: ${e.message}`);
  }
}

async function setRandomProxy() {
  if (!PROXY_LIST || PROXY_LIST.length === 0) return;
  
  // Limpiamos primero por seguridad
  await clearProxy();

  const raw = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  const parts = raw.split(':');
  
  // Asumimos formato IP:PORT:USER:PASS (el de Webshare)
  if (parts.length === 4) {
    const [ip, port, user, pass] = parts;
    const proxyUrl = `http://${ip}:${port}`;
    try {
      // Usamos flags separadas, es más robusto
      await runCmd('mega-proxy', [proxyUrl, `--username=${user}`, `--password=${pass}`], { quiet: true });
      CURRENT_PROXY = proxyUrl;
      log.info(`[PROXY] Aplicado: ${proxyUrl}`);
    } catch (e) {
      log.warn(`[PROXY] Falló al aplicar ${proxyUrl}: ${e.message}`);
      await clearProxy();
    }
  } else {
    // Fallback para otros formatos
    log.warn(`[PROXY] Formato desconocido, saltando: ${raw}`);
  }
}

async function clearProxy() {
  try { await runCmd('mega-proxy', ['--none'], { quiet: true }); } catch {}
  CURRENT_PROXY = null;
}

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

function buildCtx(acc){ 
    return acc ? `accId=${acc.id} alias=${acc.alias||'--'} email=${acc.email||'--'}` : '' 
}

function getAccountKey(acc){
  if (!acc) return 'unknown';
  // id es lo más estable, pero por si viene null en algún contexto, caemos a email
  return `id=${acc.id ?? 'NA'}|email=${acc.email ?? 'NA'}`;
}

function runCmd(cmd, args = [], { quiet = false, timeoutMs = 0 } = {}) {
  const printable = `${cmd} ${(args || []).join(' ')}`.trim();
  log.verbose(`[CRON] cmd ${printable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true });
    let out = '', err = '';
    let settled = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch {} 
        const msg = `TIMEOUT ${cmd} after ${timeoutMs}ms`;
        if (!quiet) log.warn(`[CRON] ${msg}`);
        reject(new Error(msg));
      }, timeoutMs);
    }

    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) return resolve({ out, err });
      if (!quiet && !err.includes('No proxy')) log.warn(`[CRON] fallo cmd ${cmd} code=${code} msg=${(err || out).slice(0, 160)}`);
      reject(new Error(err || out || `${cmd} exited ${code}`));
    });
    
    child.on('error', e => {
        if (timer) clearTimeout(timer);
        if (!settled) { settled = true; reject(e); }
    });
  });
}

function pickFirstFileFromLs(lsOut){
  const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
  const withExt = lines.filter(l => /\.[A-Za-z0-9]{1,10}$/.test(l))
  return (withExt[0] || lines[0]) || null
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)) }

function parseSizeToMB(str){
  if (!str) return 0
  const s = String(str).trim().toUpperCase()
  const m = s.match(/[\d.,]+\s*[KMGT]?B/)
  if (!m) return 0
  const num = parseFloat((m[0].match(/[\d.,]+/) || ['0'])[0].replace(',', '.'))
  const unit = (m[0].match(/[KMGT]?B/) || ['MB'])[0]
  const factor = unit === 'KB' ? 1/1024 : unit === 'MB' ? 1 : unit === 'GB' ? 1024 : unit === 'TB' ? 1024*1024 : 1/(1024*1024)
  return Math.round(num * factor)
}

function truncateBody(s, max = 240) {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

// Prisma/Mysql: Notification.body históricamente fue VARCHAR(191)
const NOTIFICATION_BODY_MAX = 191;

async function notifyAutomationError({ title, body }) {
  try {
    await prisma.notification.create({
      data: {
        title,
        body: truncateBody(body, NOTIFICATION_BODY_MAX),
        status: 'UNREAD',
        type: 'AUTOMATION',
        typeStatus: 'ERROR'
      }
    });
  } catch (e) {
    log.warn(`[NOTIF] No se pudo crear notificación: ${e.message}`);
  }
}

function stripAnsi(s='') {
  return String(s).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function getAccountMetrics(base){
  // base se deja por compatibilidad (por si luego se usa mega-du/mega-find)
  let storageUsedMB = 0, storageTotalMB = 0;
  let fileCount = 0, folderCount = 0;
  let storageSource = 'none';

  let txt = '';
  try {
    const df = await runCmd('mega-df', ['-h'], { quiet: true, timeoutMs: 15000 });
    txt = stripAnsi((df.out || df.err || '').toString());

    // Formato nuevo (MEGAcmd recientes):
    //   USED STORAGE: 18.11 GB  90.53% of 20.00 GB
    //   Cloud drive:  18.11 GB in 69 file(s) and 69 folder(s)
    let m = txt.match(/USED\s+STORAGE:\s*([\d.,]+\s*[KMGT]?B).*?\bof\s*([\d.,]+\s*[KMGT]?B)/i);
    if (!m) {
      // fallback por si cambia el wording
      m = txt.match(/\bUSED\s+STORAGE\b.*?([\d.,]+\s*[KMGT]?B).*?\bof\s*([\d.,]+\s*[KMGT]?B)/i);
    }
    if (m) {
      storageUsedMB = parseSizeToMB(m[1]);
      storageTotalMB = parseSizeToMB(m[2]);
      storageSource = 'df -h USED STORAGE';
    }

    const c = txt.match(/Cloud\s+drive:\s*[\d.,]+\s*[KMGT]?B\s+in\s+(\d+)\s+file\(s\)\s+and\s+(\d+)\s+folder\(s\)/i);
    if (c) {
      fileCount = Number(c[1]) || 0;
      folderCount = Number(c[2]) || 0;
      if (storageSource === 'none') storageSource = 'df -h Cloud drive';
    }

    // Fallback a formatos antiguos que el script ya soportaba (por si el output cambia)
    if (!storageTotalMB) {
      const mf = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
        || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
        || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i);
      if (mf) {
        storageUsedMB = parseSizeToMB(mf[1]);
        storageTotalMB = parseSizeToMB(mf[2]);
        storageSource = storageSource === 'none' ? 'df -h fallback' : storageSource;
      }
    }

    if (storageSource === 'none') {
      log.warn(`[METRICS] No pude parsear mega-df -h. Output (first 400): ${txt.slice(0,400)}`);
    }
  } catch (e) {
    log.warn(`[METRICS] mega-df falló: ${e.message}. Output (first 200): ${txt.slice(0,200)}`);
  }

  if (!storageTotalMB) storageTotalMB = DEFAULT_FREE_QUOTA_MB;
  if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;

  return { storageUsedMB, storageTotalMB, fileCount, folderCount, storageSource };
}

async function megaLogin(payload, ctx) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const TIMEOUT_LOGIN = 60000; // 60s para asegurar conexión con proxies lentos

      if (payload?.type === 'session' && payload.session) {
        await runCmd('mega-login', [payload.session], { quiet: true, timeoutMs: TIMEOUT_LOGIN });
      } else if (payload?.username && payload?.password) {
        await runCmd('mega-login', [payload.username, payload.password], { quiet: true, timeoutMs: TIMEOUT_LOGIN });
      } else {
        throw new Error('Credenciales inválidas');
      }
      log.info(`[MEGA][LOGIN][OK] ${ctx} intento=${attempt} proxy=${CURRENT_PROXY || 'off'}`);
      return;
    } catch (e) {
      log.warn(`[MEGA][LOGIN][FAIL] intento=${attempt} ${ctx} msg=${e.message}`);

      // Si tenemos sticky por cuenta, intentamos refrescar el proxy asignado y reintentar una vez
      if (STICKY_PROXY_ENABLED && STICKY_PROXY_REFRESH_ON_LOGIN_FAIL && payload && attempt === 1) {
        try {
          // ctx incluye accId=..., lo extraemos para best-effort
          const mId = String(ctx || '').match(/accId=(\d+)/);
          const accId = mId ? Number(mId[1]) : null;
          if (accId) {
            const key = `id=${accId}|email=`; // email no siempre está en ctx
            // Borramos cualquier asignación que coincida por prefijo id para forzar reasignación
            for (const k of Array.from(STICKY_PROXY_BY_ACCOUNT.keys())) {
              if (k.startsWith(`id=${accId}|`)) STICKY_PROXY_BY_ACCOUNT.delete(k);
            }
          }
          await setValidatedProxy(STICKY_PROXY_MAX_TRIES);
          // Reintento inmediato con el nuevo estado de proxy
          if (payload?.type === 'session') await runCmd('mega-login', [payload.session], { quiet: true, timeoutMs: TIMEOUT_LOGIN });
          else await runCmd('mega-login', [payload.username, payload.password], { quiet: true, timeoutMs: TIMEOUT_LOGIN });
          log.info(`[MEGA][LOGIN][OK][STICKY-REFRESH] ${ctx} proxy=${CURRENT_PROXY || 'off'}`);
          return;
        } catch (er) {
          // seguimos con el flujo normal de reset
        }
      }
      
      // Si fallamos, asumimos estado corrupto y reiniciamos servidor
      if (uploadsAreActiveNow()) {
        log.warn(`[MEGA][LOGIN] No reinicio MEGAcmd por subidas activas. ${ctx}`);
      } else {
        await resetMegaServer();
      }
      await clearProxy();

      // Fallback: Intento sin proxy después del reinicio
      try {
        if (payload?.type === 'session') await runCmd('mega-login', [payload.session], { quiet: true, timeoutMs: 40000 });
        else await runCmd('mega-login', [payload.username, payload.password], { quiet: true, timeoutMs: 40000 });
        
        log.info(`[MEGA][LOGIN][OK][FALLBACK] ${ctx} (sin proxy)`);
        return;
      } catch (ef) {}

      await sleep(2000 * attempt);
    }
  }
}

async function megaLogout(ctx){ try { await runCmd('mega-logout',[],{ quiet:true }); log.info(`[MEGA][LOGOUT][OK] ${ctx}`) } catch(e){ log.warn(`[MEGA][LOGOUT][WARN] ${ctx} ${e.message}`) } }

// ==========================================
// LÓGICA PRINCIPAL
// ==========================================
export async function runAutoRestoreMain(){
  const tStart = Date.now()
  const RUN_LOCK = path.join(TEMP_DIR, 'auto-restore-main.running')
  const forced = process.env.MAIN_ACCOUNT_ID?Number(process.env.MAIN_ACCOUNT_ID):null
  const maxAssets = process.env.MAX_ASSETS!==undefined ? Number(process.env.MAX_ASSETS) : null
  let main
  
  try {
     await runCmd('mega-speed-limit', ['-d', '2048'], { quiet:true });
     await runCmd('mega-speed-limit', ['-u', '2048'], { quiet:true });
  } catch {}

  try {
    if (fs.existsSync(RUN_LOCK)){
      const ageMin = (Date.now() - fs.statSync(RUN_LOCK).mtimeMs) / 60000
      if (ageMin < 240){
        log.info('[CRON][SKIP] Ejecución en curso (lock activo).')
        return { ok:true, skipped:true, reason:'RUNNING' }
      }
    }
    try { fs.writeFileSync(RUN_LOCK, String(new Date().toISOString())) } catch{}
    
    try {
      const st = fs.existsSync(UPLOADS_ACTIVE_FLAG) ? fs.statSync(UPLOADS_ACTIVE_FLAG) : null
      if (st){
        const ageMin = (Date.now() - st.mtimeMs) / 60000
        const maxIdleMin = process.env.UPLOADS_ACTIVE_MAX_IDLE_MIN ? Number(process.env.UPLOADS_ACTIVE_MAX_IDLE_MIN) : 60
        if (ageMin < maxIdleMin){
          log.info(`[CRON][SKIP] Subidas activas detectadas.`)
          return { ok:true, skipped:true, reason:'UPLOADS_ACTIVE' }
        }
      }
    } catch(e){}

    if (forced){
      main = await prisma.megaAccount.findUnique({ where:{ id:forced }, include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } } })
      if (!main) throw new Error(`Main forzada inválida`)
    } else {
      const mains = await prisma.megaAccount.findMany({
        where:{ type:'main', suspended:false, backups:{ some:{} }, assets:{ some:{} } },
        include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } }
      })
      mains.sort((a,b)=> (a.lastCheckAt?.getTime()||0) - (b.lastCheckAt?.getTime()||0))
      main = mains[0]
    }
    if (!main) { log.info('[CRON] No hay main candidate'); return { ok:true, skipped:true, reason:'NO_MAIN' } }
    if (!main.credentials) throw new Error('Main sin credenciales')
    
    const backupAccounts = (main.backups||[]).map(r=>r.backupAccount).filter(Boolean)
    if (!backupAccounts.length){ log.info('[CRON] Main sin backups'); return { ok:true, skipped:true, reason:'NO_BACKUPS' } }

    if (maxAssets === 0) return { ok:true, skipped:true, reason:'MAX_ASSETS_ZERO' }

    let candidateAssets = await prisma.asset.findMany({
      where: { accountId: main.id },
      select: { id: true, slug: true, archiveName: true, megaLink: true }
    })
    
    if (!candidateAssets.length){
      const backupIds = (backupAccounts||[]).map(b=>b.id)
      if (backupIds.length){
        const replicas = await prisma.assetReplica.findMany({
          where: { accountId: { in: backupIds }, status: 'COMPLETED' },
          select: { asset: { select: { id: true, slug: true, archiveName: true, megaLink: true } } }
        })
        const uniq = new Map(); for (const r of replicas){ if (r.asset) uniq.set(r.asset.id, r.asset) }
        candidateAssets = Array.from(uniq.values())
        if (candidateAssets.length) log.info(`[CRON][FALLBACK] Usando ${candidateAssets.length} assets de réplicas`)
      }
    }
    const assetMap = new Map(candidateAssets.map(a => [a.id, a]))
    if (maxAssets) candidateAssets = candidateAssets.slice(0, maxAssets)

    // --- ESCENARIO 1: SOLO METRICAS ---
    if (!candidateAssets.length){
      log.info('[CRON] MAIN sin assets. Actualizando métricas...')
      await withMegaLock(async () => {
        await setStickyProxyForAccount(main);
        try {
          const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
          await safeMegaLogout(buildCtx(main), 'metrics-main-pre'); await megaLogin(payload, buildCtx(main))
          const m = await getAccountMetrics((main.baseFolder||'/').replaceAll('\\','/'))
          await prisma.megaAccount.update({ where:{ id: main.id }, data:{
            status: 'CONNECTED', lastCheckAt: new Date(),
            storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
          }})
        } catch(e){} finally { await safeMegaLogout(buildCtx(main), 'metrics-main-finally'); await safeClearProxy('metrics-main-finally'); }
      }, 'CRON-METRICS-MAIN')
      
      // Warmup Backups
      for (const b of backupAccounts){
        if (!b?.credentials) continue
        await sleep(2000); 
        await withMegaLock(async () => {
          await setStickyProxyForAccount(b);
          try {
             const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
             await safeMegaLogout(buildCtx(b), 'metrics-backup-pre'); await megaLogin(payloadB, buildCtx(b))
             const m = await getAccountMetrics((b.baseFolder||'/').replaceAll('\\','/'))
             await prisma.megaAccount.update({ where:{ id: b.id }, data:{
                status: 'CONNECTED', lastCheckAt: new Date(),
                storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
             }})
          } catch(e){} finally { await safeMegaLogout(buildCtx(b), 'metrics-backup-finally'); await safeClearProxy('metrics-backup-finally'); }
        }, `CRON-METRICS-${b.id}`)
      }
      return { ok:true, skipped:true, reason:'NO_ASSETS' }
    }

    // --- ESCENARIO 2: RESTAURACIÓN ---
    log.info('____ INICIANDO RESTAURACIÓN (ANTI-BAN) ____')
    const existingSet = new Set(), needDownload = new Map(), recovered = new Map()
    let regeneratedLinks=0, restored=0

    // FASE 1: MAIN (Scan)
    await withMegaLock(async () => {
      await setStickyProxyForAccount(main);
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      await safeMegaLogout(buildCtx(main), 'phase1-main-pre')
      await megaLogin(payload, buildCtx(main))
      const remoteBaseMain = (main.baseFolder||'/').replaceAll('\\','/')
      for (let i=0;i<candidateAssets.length;i++){
        const asset = candidateAssets[i]
        const remoteFolder = path.posix.join(remoteBaseMain, asset.slug)
        const expectedFile = asset.archiveName ? path.basename(asset.archiveName) : null
        let lsOut=''
        try { const ls = await runCmd('mega-ls',[remoteFolder],{ quiet:true }); lsOut=ls.out } catch {}
        const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
        let fileName=null
        if (expectedFile && lines.includes(expectedFile)) fileName=expectedFile
        if (!fileName) fileName = pickFirstFileFromLs(lsOut)
        const exists=!!fileName
        if (exists){
          existingSet.add(asset.id)
          if (!asset.megaLink && fileName){
            try {
              const remoteFile = path.posix.join(remoteFolder, fileName)
              try { await runCmd('mega-export',['-d', remoteFile],{ quiet:true }) } catch{}
              const exp= await runCmd('mega-export',['-a', remoteFile],{ quiet:true })
              const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
              if (m){ await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink:m[0], status:'PUBLISHED' } }); regeneratedLinks++; }
            } catch (e){ log.warn(`[CRON][ESCANEO] No se pudo regenerar link para asset=${asset.id} -> ${e.message}`) }
          }
        } else {
          needDownload.set(asset.id, asset)
        }
      }
      // Medimos y actualizamos métricas de la MAIN
      try {
        const m = await getAccountMetrics(remoteBaseMain)
        await prisma.megaAccount.update({
          where:{ id: main.id },
          data:{
            status: 'CONNECTED',
            statusMessage: null,
            lastCheckAt: new Date(),
            storageUsedMB: m.storageUsedMB,
            storageTotalMB: m.storageTotalMB,
            fileCount: m.fileCount,
            folderCount: m.folderCount,
          }
        })
        log.info(`[CRON][MÉTRICAS][MAIN] alias=${main.alias||'--'} usados=${m.storageUsedMB}MB de ${m.storageTotalMB}MB | archivos=${m.fileCount} carpetas=${m.folderCount} (fuente=${m.storageSource})`)
      } catch(e){ log.warn(`[CRON][MÉTRICAS][MAIN][WARN] No se pudo actualizar métricas: ${e.message}`) }
      await safeMegaLogout(buildCtx(main), 'phase1-main-post')
      await safeClearProxy('phase1-main-post');
    }, 'CRON-PHASE1')
    log.info(`[CRON][RESUMEN][FASE1] existentes=${existingSet.size} faltantes=${needDownload.size} linksRegenerados=${regeneratedLinks}`)

    // FASE 2: Descargar faltantes desde BACKUPs
    if (needDownload.size){
      for (const b of backupAccounts){
        if (!needDownload.size) break
        const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
        await withMegaLock( async () => {
          await setStickyProxyForAccount(b);
          await safeMegaLogout(buildCtx(b), 'phase2-backup-pre'); await megaLogin(payloadB, buildCtx(b))
          for (const [assetId, asset] of Array.from(needDownload.entries())){
            const remoteBaseB = (b.baseFolder||'/').replaceAll('\\','/')
            const remoteFolderB = path.posix.join(remoteBaseB, asset.slug)
            let lsOut=''; try { const ls = await runCmd('mega-ls',[remoteFolderB],{ quiet:true }); lsOut=ls.out } catch { continue }
            const fileName = pickFirstFileFromLs(lsOut); if (!fileName) continue
            const remoteFile = path.posix.join(remoteFolderB, fileName)
            const localTemp = path.join(TEMP_DIR, `restore-${asset.id}-${Date.now()}-${fileName}`)
            try {
              await runCmd('mega-get',[remoteFile, localTemp],{ quiet:true })
              if (fs.existsSync(localTemp)){
                const size = fs.statSync(localTemp).size
                recovered.set(asset.id,{ fileName, localTemp, size }); needDownload.delete(asset.id)
                log.info(`[CRON][DESCARGA] asset=${asset.id} desde backup=${b.id} bytes=${size}`)
              }
            } catch (e){ log.warn(`[CRON][DESCARGA] fallo asset=${asset.id} desde backup=${b.id} -> ${e.message}`) }
          }
          await safeMegaLogout(buildCtx(b), 'phase2-backup-post')
          await safeClearProxy('phase2-backup-post');
        }, `CRON-DL-${b.id}`)
      }
    }

    // FASE 3: Subir a MAIN y exportar link
    await withMegaLock(async () => {
      if (recovered.size){
        await setStickyProxyForAccount(main);
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        await safeMegaLogout(buildCtx(main), 'phase3-main-pre'); await megaLogin(payload, buildCtx(main))
        for (const [assetId, info] of recovered.entries()){
          const asset = assetMap.get(assetId)
          const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
          const remoteFolder = path.posix.join(remoteBase, asset.slug)
            try { await runCmd('mega-mkdir',['-p', remoteFolder],{ quiet:true }) } catch{}
          const remoteFile = path.posix.join(remoteFolder, info.fileName)
          try {
            await runCmd('mega-put',[info.localTemp, remoteFile],{ quiet:true })
            try { await runCmd('mega-export',['-d', remoteFile],{ quiet:true }) } catch{}
            const exp = await runCmd('mega-export',['-a', remoteFile],{ quiet:true })
            const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
            if (!m) throw new Error('No link')
            await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink:m[0], status:'PUBLISHED' } })
            restored++
            log.info(`[CRON][SUBIDA] asset=${asset.id} restaurado y publicado`)
          } catch (e){ log.error(`[CRON][SUBIDA] fallo asset=${asset.id} -> ${e.message}`) }
          finally { try { if (fs.existsSync(info.localTemp)) fs.unlinkSync(info.localTemp) } catch{} }
        }
        await safeMegaLogout(buildCtx(main), 'phase3-main-post'); await safeClearProxy('phase3-main-post');
      }
    }, 'CRON-PHASE3')

    const skippedExisting = existingSet.size
    const notRecovered = Array.from(needDownload.keys()).length
    const durMs = Date.now() - tStart
    const completos = (restored===0 && skippedExisting===candidateAssets.length)
    if (completos){
      log.info(`[CRON][FINAL] Assets COMPLETOS para MAIN alias=${main.alias||'--'} (id=${main.id}). total=${candidateAssets.length} (existentes=${skippedExisting}, restaurados=0, linksRegenerados=${regeneratedLinks}). duraciónMs=${durMs}`)
    } else {
      log.info(`[CRON][FINAL] MAIN alias=${main.alias||'--'} (id=${main.id}). total=${candidateAssets.length} restaurados=${restored} existentes=${skippedExisting} linksRegenerados=${regeneratedLinks} noRecuperados=${notRecovered} duraciónMs=${durMs}`)
    }
    await prisma.megaAccount.update({ where:{ id: main.id }, data:{ lastCheckAt: new Date() } }).catch(()=>{})

    // Solo ahora, cuando todo el proceso de MAIN ha finalizado, actualizamos BACKUPs
    log.info('[CRON][WARMUP] Esperando 10s antes de autenticar BACKUPs (post-proceso MAIN)...')
    await sleep(10000)
    for (const b of backupAccounts){
      if (!b?.credentials) continue
      const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
      await withMegaLock(async () => {
        await setStickyProxyForAccount(b);
        try {
          await safeMegaLogout(buildCtx(b), 'warmup-backup-pre');
          await megaLogin(payloadB, buildCtx(b))
          const remoteBaseB = (b.baseFolder||'/').replaceAll('\\','/')
          try {
            const m = await getAccountMetrics(remoteBaseB)
            await prisma.megaAccount.update({
              where:{ id: b.id },
              data:{
                status: 'CONNECTED',
                statusMessage: null,
                lastCheckAt: new Date(),
                storageUsedMB: m.storageUsedMB,
                storageTotalMB: m.storageTotalMB,
                fileCount: m.fileCount,
                folderCount: m.folderCount,
              }
            })
            log.info(`[CRON][MÉTRICAS][BACKUP] alias=${b.alias||'--'} usados=${m.storageUsedMB}MB de ${m.storageTotalMB}MB | archivos=${m.fileCount} carpetas=${m.folderCount} (fuente=${m.storageSource})`)
          } catch(me){
            await prisma.megaAccount.update({ where:{ id: b.id }, data:{ lastCheckAt: new Date(), status: 'CONNECTED', statusMessage: null } })
            log.warn(`[CRON][MÉTRICAS][BACKUP][WARN] No se pudieron obtener métricas de alias=${b.alias||'--'}: ${me.message}`)
          }
        } catch(e){
          log.warn(`[CRON][WARMUP][WARN] No se pudo autenticar backup id=${b.id}: ${e.message}`)
          await notifyAutomationError({
            title: 'Fallo validación/autenticación BACKUP (CRON)',
            body: `Backup id=${b.id} alias=${b.alias||'--'} email=${b.email||'--'} | error=${e.message}`
          })
        } finally {
          try { await safeMegaLogout(buildCtx(b), 'warmup-backup-finally') } catch{}
          await safeClearProxy('warmup-backup-finally');
        }
      }, `CRON-WARMUP-${b.id}`)
    }
    
    if (restored > 0) {
      try {
        const notifTitle = 'Restauración automática de assets desde backups completada'
        const notifBody = `Cuenta MAIN ${main.alias||'--'} (${main.email||'--'}). Total: ${candidateAssets.length}. Restaurados: ${restored}. Existentes: ${skippedExisting}. Links regenerados: ${regeneratedLinks}. No recuperados: ${notRecovered}. Duración: ${durMs} ms.`
        await prisma.notification.create({ data: { title: notifTitle, body: truncateBody(notifBody, NOTIFICATION_BODY_MAX), status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'SUCCESS' } })
      } catch(e){ log.warn('[NOTIF][CRON] No se pudo crear notificación (restored>0): '+e.message) }
    } else if (notRecovered > 0) {
      try {
        const pendingIds = Array.from(needDownload.keys())
        const notifTitle = 'Fallo en restauración automática de assets'
        const notifBody = `Cuenta MAIN ${main.alias||'--'} (${main.email||'--'}). Faltantes=${pendingIds.length}. Ninguno restaurado. IDs pendientes: ${pendingIds.slice(0,50).join(', ')}${pendingIds.length>50?' ...':''}. Links regenerados: ${regeneratedLinks}. Duración: ${durMs} ms.`
        await prisma.notification.create({ data: { title: notifTitle, body: truncateBody(notifBody, NOTIFICATION_BODY_MAX), status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'ERROR' } })
      } catch(e){ log.warn('[NOTIF][CRON][FAIL] No se pudo crear notificación de fallo: '+e.message) }
    } else {
      log.info('[CRON][NOTIF][SKIP] restored=0 pero noRecovered=0 (todos existen, sin restauraciones)')
    }
    return { ok:true, restored, existing: skippedExisting, regeneratedLinks, notRecovered, total: candidateAssets.length }
  } catch (e){
    log.error(`[CRON][RESTORE] fallo general: ${e.message}`)
    try {
      const errBody = `Ocurrió un error al restaurar backups hacia assets (MAIN id=${main?.id||'?'} alias=${main?.alias||'--'}): ${e.message}`
      await prisma.notification.create({
        data: {
          title: 'Error en restauración automática de backups',
          body: truncateBody(errBody, NOTIFICATION_BODY_MAX),
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'ERROR'
        }
      })
    } catch(err){ log.warn('[NOTIF][CRON][ERROR] No se pudo crear notificación de error: '+err.message) }
    return { ok:false, error:e.message }
  } finally {
    try { if (fs.existsSync(RUN_LOCK)) fs.unlinkSync(RUN_LOCK) } catch{}
    // Nunca tocar sesión/proxy si hay subidas activas (protege uploader en paralelo)
    if (!uploadsAreActiveNow()) {
      try { await runCmd('mega-logout',[],{ quiet:true }) } catch{}
      try { await clearProxy() } catch{}
    } else {
      log.warn('[CRON][FINALLY][SKIP] subidas activas: no hago mega-logout/clearProxy');
    }
    try { await prisma.$disconnect() } catch{}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAutoRestoreMain().then(r=>{ if(!r.ok) process.exitCode=1 })
}

function maskProxyForLogs(raw) {
  // raw esperado: IP:PORT:USER:PASS
  const parts = String(raw || '').split(':');
  if (parts.length !== 4) return String(raw || '').slice(0, 64);
  const [ip, port, user] = parts;
  return `${ip}:${port}:${user}:***`;
}

function buildHttpProxyAuthUrl(raw) {
  // raw esperado: IP:PORT:USER:PASS
  const parts = String(raw || '').split(':');
  if (parts.length !== 4) return null;
  const [ip, port, user, pass] = parts;
  return { ip, port, user, pass, proxyUrl: `http://${ip}:${port}`, proxyAuthUrl: `http://${user}:${pass}@${ip}:${port}` };
}

async function validateProxyWithCurl(raw) {
  const built = buildHttpProxyAuthUrl(raw);
  if (!built) return { ok: false, reason: 'FORMATO_INVALIDO' };

  // -I: HEAD, -L: follow redirects, -sS: silent but show errors
  // --proxy: set proxy, --max-time: timeout
  const args = [
    '-I',
    '-L',
    '-sS',
    '--proxy',
    built.proxyAuthUrl,
    '--max-time',
    String(PROXY_CURL_TIMEOUT_S),
    PROXY_CURL_TEST_URL,
  ];

  try {
    const r = await runCmd('curl', args, { quiet: true, timeoutMs: (PROXY_CURL_TIMEOUT_S + 2) * 1000 });
    const txt = (r.out || r.err || '').toString();
    // Consideramos OK si curl logró una respuesta HTTP (código 200-399 típico en la primera línea)
    const m = txt.match(/HTTP\/[0-9.]+\s+(\d{3})/i);
    const code = m ? Number(m[1]) : 0;
    if (code >= 200 && code < 400) return { ok: true, code };
    return { ok: false, reason: `HTTP_${code || 'NO_HTTP'}` };
  } catch (e) {
    return { ok: false, reason: e.message || 'CURL_ERROR' };
  }
}

async function setValidatedProxy(maxTries = 5) {
  if (!PROXY_LIST || PROXY_LIST.length === 0) {
    CURRENT_PROXY = null;
    return { ok: false, reason: 'NO_PROXIES' };
  }

  // Siempre partimos limpio
  await clearProxy();

  const tries = Math.min(Math.max(Number(maxTries) || 1, 1), PROXY_LIST.length);
  const startIdx = Math.floor(Math.random() * PROXY_LIST.length);

  for (let i = 0; i < tries; i++) {
    const raw = PROXY_LIST[(startIdx + i) % PROXY_LIST.length];
    const masked = maskProxyForLogs(raw);

    const v = await validateProxyWithCurl(raw);
    if (!v.ok) {
      log.warn(`[PROXY][VALIDATION] FAIL ${masked} reason=${v.reason}`);
      continue;
    }

    const built = buildHttpProxyAuthUrl(raw);
    if (!built) continue;

    try {
      await runCmd('mega-proxy', [built.proxyUrl, `--username=${built.user}`, `--password=${built.pass}`], { quiet: true });
      CURRENT_PROXY = built.proxyUrl;
      log.info(`[PROXY][VALIDATION] OK ${built.proxyUrl} (curl=${v.code || 'ok'})`);
      return { ok: true, proxy: built.proxyUrl };
    } catch (e) {
      log.warn(`[PROXY] Falló al aplicar ${built.proxyUrl}: ${e.message}`);
      await clearProxy();
    }
  }

  log.warn('[PROXY][VALIDATION] Ningún proxy pasó la validación. Continuando sin proxy.');
  await clearProxy();
  return { ok: false, reason: 'ALL_FAILED' };
}

async function applyProxyRaw(raw){
  if (!raw) {
    await clearProxy();
    return { ok: true, proxy: null, mode: 'direct' };
  }
  const built = buildHttpProxyAuthUrl(raw);
  if (!built) {
    await clearProxy();
    return { ok: false, reason: 'FORMATO_INVALIDO' };
  }
  await runCmd('mega-proxy', [built.proxyUrl, `--username=${built.user}`, `--password=${built.pass}`], { quiet: true });
  CURRENT_PROXY = built.proxyUrl;
  return { ok: true, proxy: built.proxyUrl, mode: 'proxy' };
}

async function setStickyProxyForAccount(acc, { maxTries = STICKY_PROXY_MAX_TRIES, forceRefresh = false } = {}) {
  if (!STICKY_PROXY_ENABLED) {
    await setValidatedProxy(maxTries);
    return { ok: true, sticky: false, proxy: CURRENT_PROXY || null };
  }

  const key = getAccountKey(acc);
  const cached = STICKY_PROXY_BY_ACCOUNT.get(key);

  // Si ya tenemos asignación (proxy o directo), la reutilizamos
  if (cached && !forceRefresh) {
    try {
      await applyProxyRaw(cached.raw);
      log.info(`[PROXY][STICKY] Reutilizando para ${key}: ${cached.proxyUrl || 'direct'}`);
      return { ok: true, sticky: true, proxy: cached.proxyUrl || null };
    } catch (e) {
      // Si aplicar falla, forzamos reasignación
      log.warn(`[PROXY][STICKY] Falló re-aplicar para ${key}: ${e.message}. Reasignando...`);
      STICKY_PROXY_BY_ACCOUNT.delete(key);
    }
  }

  // Si no hay proxies, fijamos DIRECTO y lo cacheamos
  if (!PROXY_LIST || PROXY_LIST.length === 0) {
    await clearProxy();
    STICKY_PROXY_BY_ACCOUNT.set(key, { raw: null, proxyUrl: null });
    log.info(`[PROXY][STICKY] ${key}: direct (no proxies)`);
    return { ok: true, sticky: true, proxy: null };
  }

  // Intentamos asignar un proxy válido y lo cacheamos
  await clearProxy();
  const tries = Math.min(Math.max(Number(maxTries) || 1, 1), PROXY_LIST.length);
  const startIdx = Math.floor(Math.random() * PROXY_LIST.length);

  for (let i = 0; i < tries; i++) {
    const raw = PROXY_LIST[(startIdx + i) % PROXY_LIST.length];
    const masked = maskProxyForLogs(raw);

    const v = await validateProxyWithCurl(raw);
    if (!v.ok) {
      log.warn(`[PROXY][STICKY] VALIDATION FAIL ${key} ${masked} reason=${v.reason}`);
      continue;
    }

    try {
      const applied = await applyProxyRaw(raw);
      STICKY_PROXY_BY_ACCOUNT.set(key, { raw, proxyUrl: applied.proxy });
      log.info(`[PROXY][STICKY] Asignado a ${key}: ${applied.proxy} (curl=${v.code || 'ok'})`);
      return { ok: true, sticky: true, proxy: applied.proxy };
    } catch (e) {
      log.warn(`[PROXY][STICKY] APPLY FAIL ${key} ${masked}: ${e.message}`);
      await clearProxy();
    }
  }

  // Si no hay ninguno válido, fijamos DIRECTO y lo cacheamos
  await clearProxy();
  STICKY_PROXY_BY_ACCOUNT.set(key, { raw: null, proxyUrl: null });
  log.warn(`[PROXY][STICKY] ${key}: direct (no proxy válido)`);
  return { ok: true, sticky: true, proxy: null };
}
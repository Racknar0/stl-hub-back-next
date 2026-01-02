import { PrismaClient } from '@prisma/client'
import { decryptToJson } from './cryptoUtils.js'
import { withMegaLock } from './megaQueue.js'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { log } from './logger.js'

/*
  Script: validateAssetsOnLastAccount (AUTO-RESTORE MAIN + ANTI-BAN)
  Versión: FINAL PROD (Sin dependencias externas como curl)
*/

const prisma = new PrismaClient()
const UPLOADS_DIR = path.resolve('uploads')
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive:true })
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480
const UPLOADS_ACTIVE_FLAG = process.env.UPLOADS_ACTIVE_FLAG || path.join(UPLOADS_DIR, 'sync-cache', 'uploads-active.lock')

// ==========================================
// SISTEMA DE PROXIES
// ==========================================
const PROXY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'proxies.txt');
let PROXY_LIST = [];

try {
  if (fs.existsSync(PROXY_FILE)) {
    const content = fs.readFileSync(PROXY_FILE, 'utf-8');
    PROXY_LIST = content.split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(line => {
        // Formato IP:PORT:USER:PASS -> socks5://USER:PASS@IP:PORT
        const parts = line.split(':');
        if (parts.length === 4) {
          return `socks5://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
        }
        return line;
      });
    log.info(`[INIT] Proxies cargados: ${PROXY_LIST.length}`);
  } else {
    log.warn('[INIT] NO se encontró proxies.txt. Se usará IP DIRECTA.');
  }
} catch (e) {
  log.error(`[INIT] Error leyendo proxies: ${e.message}`);
}

async function setRandomProxy() {
  if (!PROXY_LIST || PROXY_LIST.length === 0) return;
  const proxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  // No validamos con curl para evitar errores de entorno.
  // Confiamos en que mega-login fallará (y reintentará) si el proxy es malo.
  try {
    await runCmd('mega-proxy', [proxy], { quiet: true });
  } catch (e) {
    await clearProxy();
  }
}

async function clearProxy() {
  try { await runCmd('mega-proxy', ['-d'], { quiet: true }); } catch {}
}

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

function buildCtx(acc){ 
    return acc ? `accId=${acc.id} alias=${acc.alias||'--'} email=${acc.email||'--'}` : '' 
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
      if (!quiet) log.warn(`[CRON] fallo cmd ${cmd} code=${code} msg=${(err || out).slice(0, 160)}`);
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

async function getAccountMetrics(base){
  const dfCmd = 'mega-df', duCmd = 'mega-du', findCmd = 'mega-find'
  let storageUsedMB=0, storageTotalMB=0, fileCount=0, folderCount=0, storageSource='none'
  try {
    const df = await runCmd(dfCmd, ['-h'], { quiet: true })
    const txt = (df.out || df.err || '').toString()
    let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
      || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
      || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
    if (m){ storageUsedMB = parseSizeToMB(m[1]); storageTotalMB = parseSizeToMB(m[2]); storageSource='df -h' }
  } catch {}
  
  if (!storageTotalMB) storageTotalMB = DEFAULT_FREE_QUOTA_MB
  if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB
  return { storageUsedMB, storageTotalMB, fileCount, folderCount, storageSource }
}

async function megaLogin(payload, ctx) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Usamos timeout: si el proxy es malo, esto muere en 45s y salta al catch
      if (payload?.type === 'session' && payload.session) {
        await runCmd('mega-login', [payload.session], { quiet: true, timeoutMs: 45000 });
      } else if (payload?.username && payload?.password) {
        await runCmd('mega-login', [payload.username, payload.password], { quiet: true, timeoutMs: 45000 });
      } else {
        throw new Error('Credenciales inválidas');
      }
      log.info(`[MEGA][LOGIN][OK] ${ctx} intento=${attempt}`);
      return;
    } catch (e) {
      log.warn(`[MEGA][LOGIN][FAIL] intento=${attempt} ${ctx} msg=${e.message}`);
      
      // Fallback: si falla con proxy, probamos UNA VEZ sin proxy para asegurar conexión
      try {
        await clearProxy();
        if (payload?.type === 'session') await runCmd('mega-login', [payload.session], { quiet: true, timeoutMs: 30000 });
        else await runCmd('mega-login', [payload.username, payload.password], { quiet: true, timeoutMs: 30000 });
        log.info(`[MEGA][LOGIN][OK][FALLBACK] ${ctx} (sin proxy)`);
        return;
      } catch (ef) {}

      await sleep(1000 * attempt);
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
  
  // Limitar velocidad (Anti-Ban)
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
    
    // Check uploads active
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

    // Seleccionar MAIN
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

    // Obtener Assets
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
        await setRandomProxy(); 
        try {
          const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
          await megaLogout(buildCtx(main)); await megaLogin(payload, buildCtx(main))
          const m = await getAccountMetrics((main.baseFolder||'/').replaceAll('\\','/'))
          await prisma.megaAccount.update({ where:{ id: main.id }, data:{
            status: 'CONNECTED', lastCheckAt: new Date(),
            storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
          }})
        } catch(e){} finally { await megaLogout(buildCtx(main)); await clearProxy(); }
      }, 'CRON-METRICS-MAIN')
      
      // Warmup Backups
      for (const b of backupAccounts){
        if (!b?.credentials) continue
        await sleep(2000); 
        await withMegaLock(async () => {
          await setRandomProxy();
          try {
             const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
             await megaLogout(buildCtx(b)); await megaLogin(payloadB, buildCtx(b))
             const m = await getAccountMetrics((b.baseFolder||'/').replaceAll('\\','/'))
             await prisma.megaAccount.update({ where:{ id: b.id }, data:{
                status: 'CONNECTED', lastCheckAt: new Date(),
                storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
             }})
          } catch(e){} finally { await megaLogout(buildCtx(b)); await clearProxy(); }
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
      await setRandomProxy();
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      await megaLogout(buildCtx(main)); await megaLogin(payload, buildCtx(main))
      
      const remoteBase = (main.baseFolder||'/').replaceAll('\\','/')
      for (const asset of candidateAssets){
        const remoteFolder = path.posix.join(remoteBase, asset.slug)
        const expected = asset.archiveName ? path.basename(asset.archiveName) : null
        let lsOut=''; try { const ls = await runCmd('mega-ls',[remoteFolder],{ quiet:true }); lsOut=ls.out } catch {}
        const lines = String(lsOut).split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
        let fName = (expected && lines.includes(expected)) ? expected : pickFirstFileFromLs(lsOut)
        
        if (fName){
          existingSet.add(asset.id)
          if (!asset.megaLink){
             try {
               const rFile = path.posix.join(remoteFolder, fName)
               const exp = await runCmd('mega-export',['-a', rFile],{ quiet:true })
               const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
               if (m){ await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink:m[0], status:'PUBLISHED' } }); regeneratedLinks++; }
             } catch {}
          }
        } else {
          needDownload.set(asset.id, asset)
        }
      }
      // Update Metrics Main
      try {
        const m = await getAccountMetrics(remoteBase)
        await prisma.megaAccount.update({ where:{ id: main.id }, data:{
            status: 'CONNECTED', lastCheckAt: new Date(),
            storageUsedMB: m.storageUsedMB, storageTotalMB: m.storageTotalMB, fileCount: m.fileCount, folderCount: m.folderCount,
        }})
      } catch(e){}
      await megaLogout(buildCtx(main)); await clearProxy();
    }, 'CRON-PHASE1')

    // FASE 2: DOWNLOAD (Backups)
    if (needDownload.size){
      log.info('[CRON] Iniciando descargas de backups...')
      for (const b of backupAccounts){
        if (!needDownload.size) break
        await sleep(2000); 

        await withMegaLock( async () => {
          await setRandomProxy(); 
          const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
          await megaLogout(buildCtx(b)); await megaLogin(payloadB, buildCtx(b))
          
          for (const [assetId, asset] of Array.from(needDownload.entries())){
            const rBaseB = (b.baseFolder||'/').replaceAll('\\','/')
            const rFolderB = path.posix.join(rBaseB, asset.slug)
            let lsOut=''; try { const ls = await runCmd('mega-ls',[rFolderB],{ quiet:true }); lsOut=ls.out } catch { continue }
            const fName = pickFirstFileFromLs(lsOut); if (!fName) continue
            
            const rFile = path.posix.join(rFolderB, fName)
            const localTemp = path.join(TEMP_DIR, `restore-${asset.id}-${Date.now()}-${fName}`)
            try {
              await runCmd('mega-get',[rFile, localTemp],{ quiet:true })
              if (fs.existsSync(localTemp)){
                recovered.set(asset.id,{ fileName:fName, localTemp, size: fs.statSync(localTemp).size })
                needDownload.delete(asset.id)
                log.info(`[CRON][DESCARGA] OK ${asset.id}`)
              }
            } catch (e){}
          }
          await megaLogout(buildCtx(b)); await clearProxy();
        }, `CRON-DL-${b.id}`)
      }
    }

    // FASE 3: UPLOAD (Main)
    await withMegaLock(async () => {
      if (recovered.size){
        await setRandomProxy(); 
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        await megaLogout(buildCtx(main)); await megaLogin(payload, buildCtx(main))
        
        for (const [assetId, info] of recovered.entries()){
          const asset = assetMap.get(assetId)
          const rBase = (main.baseFolder||'/').replaceAll('\\','/')
          const rFolder = path.posix.join(rBase, asset.slug)
          try { await runCmd('mega-mkdir',['-p', rFolder],{ quiet:true }) } catch{}
          const rFile = path.posix.join(rFolder, info.fileName)
          try {
            await runCmd('mega-put',[info.localTemp, rFile],{ quiet:true })
            const exp = await runCmd('mega-export',['-a', rFile],{ quiet:true })
            const m = exp.out.match(/https?:\/\/mega\.nz\/\S+/i)
            if (m){ await prisma.asset.update({ where:{ id: asset.id }, data:{ megaLink:m[0], status:'PUBLISHED' } }); restored++ }
          } catch (e){ log.error(`[CRON][UPLOAD] Fail: ${e.message}`) }
          finally { try { if (fs.existsSync(info.localTemp)) fs.unlinkSync(info.localTemp) } catch{} }
        }
        await megaLogout(buildCtx(main)); await clearProxy();
      }
    }, 'CRON-PHASE3')

    // Notificaciones
    const notRecovered = Array.from(needDownload.keys()).length
    if (restored > 0) {
      await prisma.notification.create({ data: { title: 'Restauración Completada', body: `Restaurados: ${restored}.`, status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'SUCCESS' }}).catch(()=>{})
    } 

    return { ok:true, restored, existing: existingSet.size, total: candidateAssets.length }

  } catch (e){
    log.error(`[CRON][ERROR] ${e.message}`)
    try { await prisma.notification.create({ data: { title: 'Error Cron', body: e.message, status: 'UNREAD', type: 'AUTOMATION', typeStatus: 'ERROR' } }) } catch{}
    return { ok:false, error:e.message }
  } finally {
    try { if (fs.existsSync(RUN_LOCK)) fs.unlinkSync(RUN_LOCK) } catch{}
    try { await runCmd('mega-logout',[],{ quiet:true }) } catch{}
    try { await clearProxy() } catch{} 
    try { await prisma.$disconnect() } catch{}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--proxy-smoke')){
    (async ()=>{
      try {
        const main = await prisma.megaAccount.findFirst({ where:{ type:'main', suspended:false }, include:{ credentials:true } })
        if (!main || !main.credentials){ log.warn('[SMOKE] No hay MAIN'); return }
        await setRandomProxy(); // Prueba seteo
        const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
        await megaLogin(payload, buildCtx(main)) // Prueba login con proxy
        log.info('[SMOKE] Login exitoso con proxy')
        await megaLogout('[SMOKE]')
      } catch (e){ log.warn('[SMOKE] fallo: '+e.message) }
      finally { await clearProxy(); await prisma.$disconnect(); }
    })()
  } else {
    runAutoRestoreMain().then(r=>{ if(!r.ok) process.exitCode=1 })
  }
}
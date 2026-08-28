import { PrismaClient } from '@prisma/client'
import { decryptToJson } from './cryptoUtils.js'
import { withMegaLock } from './megaQueue.js'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { log } from './logger.js'
import { applyMegaProxy, getStickyProxyForAccount } from './megaProxy.js'
import { runCmd } from './megaCmd.js'
import { parseSizeToMB, parseStorageFromDfText, pickFirstFileFromLs } from './megaDfParser.js'
import { megaGetWithStallRetry, megaPutWithStallRetry, applyProxyByIndexOrThrow } from './megaTransfer.js'
import { megaLoginFull, megaLogoutSafe, resetMegaServerIfSafe } from './megaSession.js'

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
  await megaLogoutSafe(`${ctx}${why ? ` why=${why}` : ''}`);
}


// ==========================================
// SISTEMA DE PROXIES
// ==========================================
let CURRENT_PROXY = null;
const PROXY_CURL_TEST_URL = 'https://www.google.com';
const PROXY_CURL_TIMEOUT_S = 10;
const STICKY_PROXY_ENABLED = true; // sticky por cuenta durante TODO el run
const STICKY_PROXY_MAX_TRIES = 5;  // cuántos proxies probar al asignar
const STICKY_PROXY_REFRESH_ON_LOGIN_FAIL = true; // si falla login, reintenta reasignando proxy

// Cache en memoria: accountKey -> { p, proxyUrl } donde p es el objeto proxy completo
const STICKY_PROXY_BY_ACCOUNT = new Map();


async function clearProxy() {
  // No se permite desactivar proxy (eso implicaría IP directa). No-op a nivel MEGAcmd.
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

// runCmd ahora viene del módulo centralizado (megaCmd.js)


function sleep(ms){ return new Promise(r=>setTimeout(r, ms)) }

// parseSizeToMB ahora viene del módulo centralizado (megaDfParser.js)

function truncateBody(s, max = 0) {
  if (s == null) return null;
  const str = String(s)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return str;
  return str.length > limit ? str.slice(0, Math.max(0, limit - 3)) + '...' : str;
}

async function notifyAutomationError({ title, body }) {
  try {
    await prisma.notification.create({
      data: {
        title,
        body: truncateBody(body),
        status: 'UNREAD',
        type: 'STORAGE',
        typeStatus: 'ERROR'
      }
    });
  } catch (e) {
    log.warn(`[NOTIF] No se pudo crear notificación: ${e.message}`);
  }
}

// stripAnsi ahora viene del módulo centralizado (megaDfParser.js lo aplica internamente)

async function getAccountMetrics(base){
  // base se deja por compatibilidad (por si luego se usa mega-du/mega-find)
  let storageUsedMB = 0, storageTotalMB = 0;
  let fileCount = 0, folderCount = 0;
  let storageSource = 'none';

  let txt = '';
  try {
    const df = await runCmd('mega-df', ['-h'], { quiet: true, timeoutMs: 15000 });
    txt = (df.out || df.err || '').toString();

    // Parser centralizado con todos los regex EN/ES + ANSI strip
    const parsed = parseStorageFromDfText(txt);
    storageUsedMB = parsed.storageUsedMB;
    storageTotalMB = parsed.storageTotalMB;
    fileCount = parsed.fileCount;
    folderCount = parsed.folderCount;
    if (storageTotalMB) storageSource = 'df -h USED STORAGE';

    // Fallback a formatos más antiguos (si el parser centralizado no encontró total)
    if (!storageTotalMB && storageSource === 'none') {
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
  let accountId = null;
  if (ctx) {
    const match = String(ctx).match(/accId=(\d+)/);
    if (match) accountId = Number(match[1]);
  }
  await megaLoginFull(prisma, accountId, payload, ctx, {
    skipStorageRefresh: true,  // autoBackup does its own getAccountMetrics
    skipProxySetup: true,      // autoBackup manages its own proxy system
    maxProxyRetries: 3,
  });
  log.info(`[MEGA][LOGIN][OK] ${ctx} proxy=${CURRENT_PROXY || 'off'}`);
}


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
      const main = await prisma.megaAccount.findUnique({ where:{ id:forced }, include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } } })
      if (!main) throw new Error(`Main forzada inválida`)
      return await processSingleMainGroup(main, maxAssets)
    }

    const mains = await prisma.megaAccount.findMany({
      where:{ type:'main', suspended:false, backups:{ some:{} }, assets:{ some:{} } },
      include:{ credentials:true, backups:{ include:{ backupAccount:{ include:{ credentials:true } } } } }
    })

    if (!mains.length){
      log.info('[CRON] No hay cuentas main candidatas');
      return { ok:true, skipped:true, reason:'NO_MAIN' }
    }

    // Tratamos MAIN + BACKUPs como un solo ente:
    // priorizamos el grupo cuya última revisión MÁS ANTIGUA sea la más vieja.
    const getTs = (d) => (d instanceof Date ? d.getTime() : (d ? new Date(d).getTime() : 0));

    const scored = mains.map(m => {
      const mainTs = getTs(m.lastCheckAt);
      const backups = (m.backups || [])
        .map(r => r?.backupAccount)
        .filter(b => b && b.suspended === false);

      let oldestTs = mainTs;
      let driver = { type: 'main', id: m.id, ts: mainTs };

      for (const b of backups) {
        const bTs = getTs(b.lastCheckAt);
        if (bTs < oldestTs) {
          oldestTs = bTs;
          driver = { type: 'backup', id: b.id, ts: bTs };
        }
      }

      return { m, oldestTs, driver };
    });

    scored.sort((a, b) => a.oldestTs - b.oldestTs);

    // CÁLCULO DINÁMICO DE BATCH
    // Garantiza que sin importar la cantidad de cuentas, se revisen todas en un máximo de TARGET_DAYS (50 días).
    const TARGET_DAYS = Number(process.env.AUTO_BACKUP_TARGET_DAYS) || 50;
    const RUNS_PER_DAY = Number(process.env.AUTO_BACKUP_RUNS_PER_DAY) || 24; // Asumiendo cron horario
    const batchSize = Math.max(1, Math.ceil(mains.length / (TARGET_DAYS * RUNS_PER_DAY)));

    const toProcess = scored.slice(0, batchSize);
    log.info(`[CRON][DYNAMIC] Total mains: ${mains.length} | Meta: ${TARGET_DAYS} días (${RUNS_PER_DAY} runs/día) | Procesando batch de ${toProcess.length} grupo(s)`);

    const summaryResults = [];
    for (let i = 0; i < toProcess.length; i++) {
      const item = toProcess[i];
      const m = item.m;
      log.info(`[CRON][PICK] [${i + 1}/${toProcess.length}] Procesando grupo mainId=${m.id} driver=${item.driver.type}:${item.driver.id} oldestTs=${new Date(item.oldestTs).toISOString()}`);
      try {
        const res = await processSingleMainGroup(m, maxAssets);
        summaryResults.push({ mainId: m.id, ok: true, res });
      } catch (e) {
        log.error(`[CRON][ERROR] Fallo procesando grupo mainId=${m.id} (${m.alias || '--'}): ${e.message}`);
        try {
          await prisma.megaAccount.update({
            where: { id: m.id },
            data: { status: 'ERROR', statusMessage: `Fallo cron: ${String(e.message).slice(0, 200)}` }
          });
          const errBody = `Ocurrió un error al procesar/restaurar grupo (MAIN id=${m.id} alias=${m.alias || '--'}): ${e.message}`;
          await prisma.notification.create({
            data: {
              title: 'Error en revisión/restauración automática de backups',
              body: truncateBody(errBody),
              status: 'UNREAD',
              type: 'STORAGE',
              typeStatus: 'ERROR'
            }
          });
        } catch {}
        summaryResults.push({ mainId: m.id, ok: false, error: e.message });
      }
    }

    return { ok: true, batchSize, processed: summaryResults.length, results: summaryResults };

  } catch (e){
    log.error(`[CRON][RESTORE] fallo general: ${e.message}`)
    return { ok:false, error:e.message }
  } finally {
    try { if (fs.existsSync(RUN_LOCK)) fs.unlinkSync(RUN_LOCK) } catch{}
    // Nunca tocar sesión/proxy si hay subidas activas (protege uploader en paralelo)
    if (!uploadsAreActiveNow()) {
      try {
        await runCmd('mega-logout', ['--keep-session'], { quiet: true })
      } catch{}
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
  await clearProxy();

  const tries = Number(maxTries) || 5;

  for (let i = 0; i < tries; i++) {
    const p = getStickyProxyForAccount(null, i);
    if (!p) {
      log.warn('[PROXY][VALIDATION] Sin proxies válidos disponibles.');
      return { ok: false, reason: 'NO_PROXIES' };
    }
    const masked = maskProxyForLogs(p.raw);

    const v = await validateProxyWithCurl(p.raw);
    if (!v.ok) {
      log.warn(`[PROXY][VALIDATION] FAIL ${masked} reason=${v.reason}`);
      continue;
    }

    try {
      const applied = await applyMegaProxy(p, { ctx: 'restore-main', timeoutMs: 15000, clearOnFail: false });
      if (applied?.enabled) {
        CURRENT_PROXY = p.proxyUrl;
        log.info(`[PROXY][VALIDATION] OK ${p.proxyUrl} (curl=${v.code || 'ok'})`);
        return { ok: true, proxy: p.proxyUrl };
      }
    } catch (e) {
      log.warn(`[PROXY] Falló al aplicar ${p.proxyUrl}: ${e.message}`);
    }
  }

  log.warn('[PROXY][VALIDATION] Ningún proxy pasó la validación. ABORTANDO (no se permite IP directa).');
  CURRENT_PROXY = null;
  return { ok: false, reason: 'ALL_FAILED' };
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
      const applied = await applyMegaProxy(cached.p, { ctx: 'restore-main:sticky-cached', timeoutMs: 15000, clearOnFail: false });
      if (applied?.enabled) {
        CURRENT_PROXY = cached.proxyUrl;
        log.info(`[PROXY][STICKY] Reutilizando para ${key}: ${cached.proxyUrl}`);
        return { ok: true, sticky: true, proxy: cached.proxyUrl || null };
      }
    } catch (e) {
      // Si aplicar falla, forzamos reasignación
      log.warn(`[PROXY][STICKY] Falló re-aplicar para ${key}: ${e.message}. Reasignando...`);
      STICKY_PROXY_BY_ACCOUNT.delete(key);
    }
  }

  // Intentamos asignar un proxy válido y lo cacheamos
  await clearProxy();
  const tries = Number(maxTries) || 5;

  for (let i = 0; i < tries; i++) {
    const p = getStickyProxyForAccount(acc, i);
    if (!p) {
      log.warn(`[PROXY][STICKY] ${key}: NO_PROXIES (abort)`);
      return { ok: false, sticky: true, reason: 'NO_PROXIES' };
    }
    const masked = maskProxyForLogs(p.raw);

    const v = await validateProxyWithCurl(p.raw);
    if (!v.ok) {
      log.warn(`[PROXY][STICKY] VALIDATION FAIL ${key} ${masked} reason=${v.reason}`);
      continue;
    }

    try {
      const applied = await applyMegaProxy(p, { ctx: `restore-main:sticky-assign:${key}`, timeoutMs: 15000, clearOnFail: false });
      if (applied?.enabled) {
        STICKY_PROXY_BY_ACCOUNT.set(key, { p, proxyUrl: p.proxyUrl });
        CURRENT_PROXY = p.proxyUrl;
        log.info(`[PROXY][STICKY] Asignado a ${key}: ${p.proxyUrl} (curl=${v.code || 'ok'})`);
        return { ok: true, sticky: true, proxy: p.proxyUrl };
      }
    } catch (e) {
      log.warn(`[PROXY][STICKY] APPLY FAIL ${key} ${masked}: ${e.message}`);
    }
  }

  // Si no hay ninguno válido, abortar
  CURRENT_PROXY = null;
  log.warn(`[PROXY][STICKY] ${key}: ALL_FAILED (abort)`);
  return { ok: false, sticky: true, reason: 'ALL_FAILED' };
}
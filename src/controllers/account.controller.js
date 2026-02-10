import { PrismaClient } from '@prisma/client';
import { encryptJson, decryptToJson } from '../utils/cryptoUtils.js';
import { log, isVerbose } from '../utils/logger.js';
import { spawn } from 'child_process';
import { withMegaLock } from '../utils/megaQueue.js';
import { applyMegaProxy, listMegaProxies, clearMegaProxyIfSafe } from '../utils/megaProxy.js';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();
// Cuota por defecto para cuentas gratuitas de MEGA (MB). Se puede sobreescribir con MEGA_FREE_QUOTA_MB
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480;
// Cuota de transferencia por defecto (si no se puede leer de mega-df). Se puede sobreescribir con MEGA_FREE_BW_MB
const DEFAULT_FREE_BW_MB = Number(process.env.MEGA_FREE_BW_MB) || 20480;

// Límite máximo de captura para evitar RangeError por acumulación de salida
const MAX_CMD_CAPTURE_BYTES = (Number(process.env.MEGA_MAX_CAPTURE_KB) || 1024) * 1024; // 1MB por defecto

// Lista de comandos cuyos logs siempre estarán silenciados salvo errores (login/logout)
const QUIET_MEGA_CMDS = new Set(['mega-login', 'mega-logout']);

const MEGA_LOGIN_TIMEOUT_MS = Number(process.env.MEGA_LOGIN_TIMEOUT_MS) || 60000;
const MEGA_LOGOUT_TIMEOUT_MS = Number(process.env.MEGA_LOGOUT_TIMEOUT_MS) || 30000;
const MEGA_MKDIR_TIMEOUT_MS = Number(process.env.MEGA_MKDIR_TIMEOUT_MS) || 20000;
const MEGA_READONLY_TIMEOUT_MS = Number(process.env.MEGA_READONLY_TIMEOUT_MS) || 30000;

const MEGA_LOGIN_PER_PROXY_TIMEOUT_MS = Number(process.env.MEGA_LOGIN_PER_PROXY_TIMEOUT_MS) || 15000;
const MEGA_PROXY_ROTATE_MAX_TRIES = Number(process.env.MEGA_PROXY_ROTATE_MAX_TRIES) || 0; // 0 = todas

function attachAutoAcceptTerms(child, label = 'MEGA') {
  const EOL = '\n';
  const ACCEPT_REGEXES = [
    /Do you accept\s+these\s+terms\??/i,
    /Do you accept.*terms\??/i,
    /Type '\s*yes\s*' to continue/i,
    /Acepta[s]? .*t[ée]rminos\??/i,
    /¿Acepta[s]? los t[ée]rminos\??/i,
  ];
  const PROMPT_YNA = /Please enter \[y\]es\/\[n\]o\/\[a\]ll\/none|\[(y|Y)\]es\s*\/\s*\[(n|N)\]o\s*\/\s*\[(a|A)\]ll/i;
  const PROMPT_YN = /\[(y|Y)\]es\s*\/\s*\[(n|N)\]o/i;
  const PROMPT_ES_SN = /\[(s|S)\]\s*\/\s*\[(n|N)\]/i;

  const maybeAnswer = (s) => {
    try {
      if (ACCEPT_REGEXES.some(r => r.test(s))) child.stdin.write('yes' + EOL);
      else if (PROMPT_YNA.test(s)) child.stdin.write('a' + EOL);
      else if (PROMPT_YN.test(s)) child.stdin.write('y' + EOL);
      else if (PROMPT_ES_SN.test(s)) child.stdin.write('s' + EOL);
    } catch (e) {
      // No es crítico; sólo evita cuelgues por prompts
      try { log.warn(`[${label}] auto-accept warn: ${e.message}`) } catch {}
    }
  };

  if (!child?.stdout || !child?.stderr) return;
  child.stdout.on('data', d => maybeAnswer(d.toString()));
  child.stderr.on('data', d => maybeAnswer(d.toString()));
}

// Ejecuta un comando y devuelve stdout/err con logs (sin exponer credenciales) limitando tamaño
function runCmd(cmd, args = [], { cwd, maxBytes, timeoutMs } = {}) {
  const maskArgs = (c, a) => (c && c.toLowerCase().includes('mega-login') ? ['<hidden>'] : a);
  const printable = `${cmd} ${(maskArgs(cmd, args) || []).join(' ')}`.trim();
  if (cmd === 'mega-login') log.info('[MEGA][LOGIN] iniciando (accounts controller)')
  if (cmd === 'mega-logout') log.info('[MEGA][LOGOUT] iniciando (accounts controller)')
  const quiet = QUIET_MEGA_CMDS.has(cmd);
  const verbose = typeof isVerbose === 'function' && isVerbose();
  if (!quiet && verbose) log.verbose(`Ejecutando comando: ${printable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: true });
    // mega-login/mega-* a veces pueden pedir aceptar términos; evitar cuelgue interactivo
    if (cmd === 'mega-login' || cmd === 'mega-export' || cmd === 'mega-put') {
      try { attachAutoAcceptTerms(child, cmd.toUpperCase()); } catch {}
    }
    let out = '', err = '';
    const limit = maxBytes || MAX_CMD_CAPTURE_BYTES;
    let truncatedOut = false, truncatedErr = false;
    let settled = false;
    let to = null;

    const effectiveTimeoutMs = Number(timeoutMs || 0);
    if (effectiveTimeoutMs > 0) {
      to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL') } catch {}
        try { child.kill() } catch {}
        log.warn(`Timeout comando ${cmd} tras ${effectiveTimeoutMs}ms`);
        reject(new Error(`${cmd} timeout`));
      }, effectiveTimeoutMs);
    }

    child.stdout.on('data', (d) => {
      if (!truncatedOut) {
        if (out.length + d.length <= limit) out += d.toString();
        else {
          const slice = limit - out.length; if (slice > 0) out += d.toString().slice(0, slice); truncatedOut = true;
        }
      }
    });
    child.stderr.on('data', (d) => {
      if (!truncatedErr) {
        if (err.length + d.length <= limit) err += d.toString();
        else {
          const slice = limit - err.length; if (slice > 0) err += d.toString().slice(0, slice); truncatedErr = true;
        }
      }
    });
    child.on('error', (e) => {
      if (to) clearTimeout(to);
      if (settled) return;
      settled = true;
      log.error(`Error spawn comando ${cmd}: ${e.message}`);
      reject(e);
    });
    child.on('close', (code) => {
      if (to) clearTimeout(to);
      if (settled) return;
      settled = true;
      if (code === 0) {
        if (cmd === 'mega-login') log.info('[MEGA][LOGIN][OK] (accounts controller)')
        if (cmd === 'mega-logout') log.info('[MEGA][LOGOUT][OK] (accounts controller)')
        if (!quiet && verbose) log.verbose(`OK comando: ${cmd}`);
        return resolve({ out, err, truncatedOut, truncatedErr });
      }
      // Manejo especial: mega-mkdir code 54 = ya existe -> silenciar si no verbose
      const msg = (err || out || '').slice(0, 500);
      if (!(cmd === 'mega-mkdir' && /already exists/i.test(msg)) || verbose) {
        log.error(`Error comando ${cmd} code=${code} msg=${msg}`);
      }
      reject(new Error(err || out || `${cmd} exited with code ${code}`));
    });
  });
}

// Ejecuta comando con timeout (mata el proceso si excede)
async function runCmdWithTimeout(cmd, args = [], timeoutMs = 15000, options = {}) {
  return runCmd(cmd, args, { cwd: options.cwd, maxBytes: options.maxBytes, timeoutMs });
}

// Subida con progreso leyendo stderr/stdout incremental de mega-put
async function runMegaPutWithProgress(localFile, remoteFolder, { assetId, backupId, index, total, globalDone, totalPlanned }) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.existsSync(localFile) ? fs.statSync(localFile).size : 0;
    const child = spawn('mega-put', [localFile, remoteFolder], { shell: true });
    let out = '', err = '';
    let lastLoggedPct = -1;
    const startTs = Date.now();
    let anyPct = false;
    const fallbackTimer = setTimeout(() => {
      if (!anyPct) {
        console.log(`[SYNC][SUBIDA][INFO] asset=${assetId} backup=${backupId} sin progreso granular (MEGAcmd no emitió %) tamaño=${fileSize}B`)
      }
    }, 4000)
    function logProgress(pct, transferred) {
      console.log(`[SYNC][SUBIDA][PROGRESO] asset=${assetId} backup=${backupId} ${(index)}/${total} global(${globalDone}/${totalPlanned}) ${pct}% ${transferred}/${fileSize}B`);
    }
    child.stdout.on('data', d => {
      const txt = d.toString();
      out += txt;
      // Buscar todos los porcentajes y usar el último
      const matches = [...txt.matchAll(/(\d{1,3})%/g)]
      if (matches.length) {
        const pct = Math.min(100, Number(matches[matches.length - 1][1]))
        anyPct = true
        if (pct !== lastLoggedPct) { lastLoggedPct = pct; logProgress(pct, Math.round(fileSize * pct / 100)); }
      }
    });
    child.stderr.on('data', d => {
      const txt = d.toString();
      err += txt;
      const matches = [...txt.matchAll(/(\d{1,3})%/g)]
      if (matches.length) {
        const pct = Math.min(100, Number(matches[matches.length - 1][1]))
        anyPct = true
        if (pct !== lastLoggedPct) { lastLoggedPct = pct; logProgress(pct, Math.round(fileSize * pct / 100)); }
      }
    });
    child.on('close', code => {
      clearTimeout(fallbackTimer)
      if (code === 0) {
        if (lastLoggedPct < 100) logProgress(100, fileSize);
        const ms = Date.now() - startTs;
        console.log(`[SYNC][SUBIDA][OK] asset=${assetId} backup=${backupId} size=${fileSize}B ms=${ms}`);
        resolve({ out, err });
      } else {
        console.warn(`[SYNC][SUBIDA][ERROR] asset=${assetId} backup=${backupId} code=${code} err=${(err||out).slice(0,200)}`);
        reject(new Error(err || out || `mega-put exit ${code}`));
      }
    });
  });
}

function parseSizeToMB(str) {
  if (!str) return 0;
  const s = String(str).trim().toUpperCase();
  const m = s.match(/[\d.,]+\s*[KMGT]?B/);
  if (!m) return 0;
  const num = parseFloat((m[0].match(/[\d.,]+/) || ['0'])[0].replace(',', '.'));
  const unit = (m[0].match(/[KMGT]?B/) || ['MB'])[0];
  const factor = unit === 'KB' ? 1/1024 : unit === 'MB' ? 1 : unit === 'GB' ? 1024 : unit === 'TB' ? 1024*1024 : 1/(1024*1024);
  return Math.round(num * factor);
}

// Flag central para habilitar/deshabilitar exportación de links públicos en sincronizaciones
// Requerimiento del usuario: NO generar ni guardar links públicos durante backups.
const ENABLE_PUBLIC_LINK_EXPORT = false;

export const listAccounts = async (_req, res) => {
  try {
    const accounts = await prisma.megaAccount.findMany({
      orderBy: { id: 'asc' },
      include: {
        backups: { include: { backupAccount: { select: { id: true, alias: true, type: true, status: true } } } },
        assignedAsBackup: { include: { mainAccount: { select: { id: true, alias: true, type: true, status: true } } } },
      },
    });

    const mapped = accounts.map(a => ({
      id: a.id,
      alias: a.alias,
      email: a.email,
      baseFolder: a.baseFolder,
      type: a.type,
      status: a.status,
      statusMessage: a.statusMessage,
      suspended: a.suspended,
      storageUsedMB: a.storageUsedMB,
      storageTotalMB: a.storageTotalMB,
      errors24h: a.errors24h,
      fileCount: a.fileCount,
      folderCount: a.folderCount,
      lastCheckAt: a.lastCheckAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      backups: (a.backups || []).map(b => ({ id: b.backupAccount.id, alias: b.backupAccount.alias, type: b.backupAccount.type, status: b.backupAccount.status })),
      mains: (a.assignedAsBackup || []).map(b => ({ id: b.mainAccount.id, alias: b.mainAccount.alias, type: b.mainAccount.type, status: b.mainAccount.status })),
    }));

    return res.json(mapped);
  } catch (error) {
    console.error('Error listing accounts:', error);
    return res.status(500).json({ message: 'Error listing accounts' });
  }
};

export const createAccount = async (req, res) => {
  try {
  const { alias, email, baseFolder, type = 'main', credentials } = req.body;
  console.log(`[ACCOUNTS] create alias=${alias} email=${email} base=${baseFolder} type=${type}`);
    if (!alias || !email || !baseFolder || !credentials) {
      return res.status(400).json({ message: 'alias, email, baseFolder y credentials son requeridos' });
    }
  const account = await prisma.megaAccount.create({ data: { alias, email, baseFolder, type, status: 'ERROR' } });
    const payload = { type: credentials.type || 'login', username: credentials.username, password: credentials.password, session: credentials.session };
    const enc = encryptJson(payload);
    await prisma.accountCredential.create({ data: { accountId: account.id, encData: enc.encData, encIv: enc.encIv, encTag: enc.encTag } });
    console.log(`[ACCOUNTS] created id=${account.id}`);
    return res.status(201).json(account);
  } catch (error) {
    console.error('[ACCOUNTS] Error creating account:', error);
    return res.status(500).json({ message: 'Error creating account' });
  }
};

export const updateAccount = async (req, res) => {
  try {
    const id = Number(req.params.id);
  const { alias, email, baseFolder, type, suspended, status } = req.body;

    // Validaciones al cambiar type para evitar estados incoherentes
    if (type !== undefined) {
      const current = await prisma.megaAccount.findUnique({
        where: { id },
        include: { backups: true, assignedAsBackup: true },
      });
      if (!current) return res.status(404).json({ message: 'Account not found' });
      const nextType = String(type);
      if (nextType !== current.type) {
        if (nextType === 'backup' && (current.backups || []).length > 0) {
          return res.status(400).json({
            message: 'No se puede cambiar a backup: esta cuenta (main) tiene backups asignados. Quita los backups primero.',
          });
        }
        if (nextType === 'main' && (current.assignedAsBackup || []).length > 0) {
          return res.status(400).json({
            message: 'No se puede cambiar a main: esta cuenta está asignada como backup de una o más cuentas. Desasigna primero.',
          });
        }
      }
    }

    const data = {};
    if (alias !== undefined) data.alias = alias;
    if (email !== undefined) data.email = email;
    if (baseFolder !== undefined) data.baseFolder = baseFolder;
  if (type !== undefined) data.type = type;
    if (suspended !== undefined) data.suspended = Boolean(suspended);
    if (status !== undefined) data.status = status; // validar enum en frontend o con zod/express-validator

    const updated = await prisma.megaAccount.update({ where: { id }, data });
    return res.json(updated);
  } catch (error) {
    console.error('Error updating account:', error);
    return res.status(500).json({ message: 'Error updating account' });
  }
};

export const deleteAccount = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const acc = await prisma.megaAccount.findUnique({
      where: { id },
      include: { backups: true, assignedAsBackup: true },
    });
    if (!acc) return res.status(404).json({ message: 'Account not found' });

    const assetsCount = await prisma.asset.count({ where: { accountId: id } });
    const replicasCount = await prisma.assetReplica.count({ where: { accountId: id } });

    // Regla del usuario: no permitir borrar main si tiene backups asociados
    if (acc.type === 'main' && (acc.backups || []).length > 0) {
      return res.status(409).json({
        message: 'No se puede eliminar una cuenta main con backups asociados. Quita los backups primero.',
      });
    }

    // Seguridad: evitar borrar main con assets (previene orfandad o pérdida accidental)
    if (acc.type === 'main' && assetsCount > 0) {
      return res.status(409).json({
        message: `No se puede eliminar una cuenta main con assets asociados (assets=${assetsCount}). Mueve/reasigna los assets primero.`,
      });
    }

    await prisma.$transaction(async (tx) => {
      // Si es backup, puede tener réplicas; las limpiamos.
      if (replicasCount > 0) {
        await tx.assetReplica.deleteMany({ where: { accountId: id } });
      }

      // Desasociar relaciones main<->backup (por si acaso, aunque hay Cascade)
      await tx.megaAccountBackup.deleteMany({
        where: { OR: [{ mainAccountId: id }, { backupAccountId: id }] },
      });

      // Credenciales (no hay cascade explícito)
      await tx.accountCredential.deleteMany({ where: { accountId: id } });

      // Finalmente, borrar la cuenta
      await tx.megaAccount.delete({ where: { id } });
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error('Error deleting account:', error);
    return res.status(500).json({ message: 'Error deleting account' });
  }
};

// Test de conexión ligero: login y ls baseFolder
export const testAccount = async (req, res) => {
  let didLogin = false;
  let stopUploadsFlag = null;
  let didSetProxy = false;
  try {
    const id = Number(req.params.id);
  log.info(`Prueba cuenta iniciada id=${id}`);
    const acc = await prisma.megaAccount.findUnique({ where: { id }, include: { credentials: true } });
    if (!acc) return res.status(404).json({ message: 'Account not found' });
    if (!acc.credentials) return res.status(400).json({ message: 'No credentials stored for this account' });
  // Datos básicos (una sola línea)
  log.verbose(`Cuenta alias=${acc.alias} email=${acc.email} base=${acc.baseFolder}`);

    // Minimizar auth requests: si hay subidas activas (batch/SCP/cron), no correr test.
    // MEGAcmd es global y un test aquí mete mega-login/logout extra y puede interferir.
    try {
      const mod = await import('../utils/uploadsActiveFlag.js');
      if (typeof mod?.isUploadsActive === 'function' && mod.isUploadsActive()) {
        log.warn(`[ACCOUNTS][TEST] uploads activos: skip test accId=${id} alias=${acc.alias || '--'}`);
        return res.status(409).json({ ok: false, busy: true, message: 'Hay subidas activas. Reintenta el test más tarde.' });
      }
      if (typeof mod?.startUploadsActive === 'function') {
        // Mientras el usuario está "conectando" (y puede tardar), activamos el flag
        // para que el CRON no intente mega-logout/reset en paralelo.
        stopUploadsFlag = mod.startUploadsActive(`connect-test:acc:${id}`);
      }
    } catch (e) {
      // No bloqueamos el test si no se pudo consultar/activar el flag
      log.warn(`[ACCOUNTS][TEST] uploads-active flag warn: ${e.message}`);
    }

    const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag);

    const loginCmd = 'mega-login';
    const logoutCmd = 'mega-logout';
    const mkdirCmd = 'mega-mkdir';
    const dfCmd = 'mega-df';
    const duCmd = 'mega-du';
    const findCmd = 'mega-find';

    const base = (acc.baseFolder || '/').trim();
    await withMegaLock(async () => {
      const ctx = `accId=${id} alias=${acc.alias || '--'}`;

      // Rotación de proxy + login con timeout corto por intento.
      // Requisito: no caer a IP directa; si no hay proxy válido o ninguno conecta, abortar.
      const proxies = listMegaProxies({});
      if (!proxies.length) {
        log.error(`[ACCOUNTS][TEST] Sin proxies válidos. Abortando login. ${ctx}`);
        throw new Error('Sin proxies válidos');
      }

      const maxTries = MEGA_PROXY_ROTATE_MAX_TRIES > 0
        ? Math.min(MEGA_PROXY_ROTATE_MAX_TRIES, proxies.length)
        : Math.min(proxies.length, 50);

      let loginOk = false;
      let lastErr = '';
      for (let i = 0; i < maxTries; i++) {
        const p = proxies[i];
        log.info(`[ACCOUNTS][TEST] Proxy try ${i + 1}/${maxTries} -> ${p.proxyUrl} ${ctx}`);

        const applied = await applyMegaProxy(p, { ctx, timeoutMs: 15000, clearOnFail: false });
        if (!applied?.enabled) {
          lastErr = applied?.error || 'apply proxy failed';
          continue;
        }
        didSetProxy = true;

        // Limpiar sesiones previas
        try {
          await runCmdWithTimeout(logoutCmd, [], MEGA_LOGOUT_TIMEOUT_MS);
          console.log('[ACCOUNTS] pre-logout ok');
        } catch (e) {
          console.warn('[ACCOUNTS] pre-logout warn:', String(e.message).slice(0, 200));
        }

        // Login con timeout de 15s por proxy
        try {
          if (payload?.type === 'session' && payload.session) {
            await runCmdWithTimeout(loginCmd, [payload.session], MEGA_LOGIN_PER_PROXY_TIMEOUT_MS);
          } else if (payload?.username && payload?.password) {
            await runCmdWithTimeout(loginCmd, [payload.username, payload.password], MEGA_LOGIN_PER_PROXY_TIMEOUT_MS);
          } else {
            throw new Error('Invalid credentials payload');
          }
          didLogin = true;
          loginOk = true;
          log.info(`[ACCOUNTS][TEST] Login OK via proxy ${p.proxyUrl} ${ctx}`);
          break;
        } catch (e) {
          const msg = String(e.message || '').toLowerCase();
          lastErr = msg;
          log.warn(`[ACCOUNTS][TEST] Login FAIL via proxy ${p.proxyUrl} err=${msg} ${ctx}`);
          if (msg.includes('already logged in')) {
            didLogin = true;
            loginOk = true;
            log.info(`[ACCOUNTS][TEST] Login already-logged-in OK via proxy ${p.proxyUrl} ${ctx}`);
            break;
          }
          // probar siguiente proxy
          continue;
        }
      }

      if (!loginOk) {
        log.error(`[ACCOUNTS][TEST] Ningún proxy conectó (tries=${maxTries}). lastErr=${String(lastErr).slice(0,200)} ${ctx}`);
        throw new Error(`No se pudo conectar por proxies tras ${maxTries} intentos`);
      }

      if (base && base !== '/') {
        try { await runCmdWithTimeout(mkdirCmd, ['-p', base], MEGA_MKDIR_TIMEOUT_MS); } catch (e) { /* silencio mkdir */ }
      }
    }, 'ACCOUNTS-TEST')

    // Métricas: SOLO almacenamiento (quitar banda). Intentar df primero, luego fallback a du.
    let storageUsedMB = 0, storageTotalMB = 0;
    // Conteos
    let fileCount = 0, folderCount = 0;

    try {
      const dfTxt = await runCmd(dfCmd, ['-h']);
      const txt = (dfTxt.out || dfTxt.err || '').toString();
      // Patrones de almacenamiento used/total (EN/ES)
      let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
           || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
           || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
           || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
           || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);
      if (m) {
        storageUsedMB = parseSizeToMB(m[1]);
        storageTotalMB = parseSizeToMB(m[2]);
      }
      // Patrón con porcentaje: "X% of Y used" (EN/ES)
      if (!storageTotalMB) {
        const p = txt.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:used|usado)?/i)
               || txt.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:usado|used)?/i);
        if (p) {
          storageTotalMB = parseSizeToMB(p[2]);
          const pct = parseFloat(String(p[1]).replace(',', '.'));
          if (!isNaN(pct) && isFinite(pct)) {
            storageUsedMB = Math.round((pct / 100) * storageTotalMB);
          }
        }
      }
      console.log(`[ACCOUNTS] df -h storage usedMB=${storageUsedMB} totalMB=${storageTotalMB}`);
    } catch (e) {
      console.warn('[ACCOUNTS] df -h warn:', String(e.message).slice(0,200));
    }

    if (!storageTotalMB) {
      try {
        const dfTxt = await runCmd(dfCmd, []);
        const txt = (dfTxt.out || dfTxt.err || '').toString();
        let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
             || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
             || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
             || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
             || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);
        if (m) {
          storageUsedMB = parseSizeToMB(m[1]);
          storageTotalMB = parseSizeToMB(m[2]);
        }
        if (!storageTotalMB) {
          const p = txt.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:used|usado)?/i)
                 || txt.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:usado|used)?/i);
          if (p) {
            storageTotalMB = parseSizeToMB(p[2]);
            const pct = parseFloat(String(p[1]).replace(',', '.'));
            if (!isNaN(pct) && isFinite(pct)) {
              storageUsedMB = Math.round((pct / 100) * storageTotalMB);
            }
          }
        }
        console.log(`[ACCOUNTS] df storage usedMB=${storageUsedMB} totalMB=${storageTotalMB}`);
      } catch (e) {
        console.warn('[ACCOUNTS] df warn:', String(e.message).slice(0,200));
      }
    }

    // Fallback: si no se obtuvo used desde df, calcular con mega-du -h del folder base
    if (!storageUsedMB) {
      try {
        const duTxt = await runCmd(duCmd, ['-h', base || '/']);
        const du = (duTxt.out || duTxt.err || '').toString();
        const mm = du.match(/[\r\n]*\s*([\d.,]+\s*[KMGT]?B)/i) || du.match(/([\d.,]+\s*[KMGT]?B)/i);
        if (mm) storageUsedMB = parseSizeToMB(mm[1]);
        console.log(`[ACCOUNTS] du -h base usedMB=${storageUsedMB}`);
      } catch (e) {
        console.warn('[ACCOUNTS] du -h warn:', String(e.message).slice(0,200));
      }
    }

    // Conteo de archivos y carpetas usando mega-find (usar --type=...)
    try {
      // Archivos
      try {
        const f = await runCmd(findCmd, [base || '/', '--type=f']);
        fileCount = (f.out || '').split(/\r?\n/).filter(Boolean).length;
      } catch {
        const f = await runCmd(findCmd, ['--type=f', base || '/']);
        fileCount = (f.out || '').split(/\r?\n/).filter(Boolean).length;
      }
      // Carpetas
      try {
        const d = await runCmd(findCmd, [base || '/', '--type=d']);
        folderCount = (d.out || '').split(/\r?\n/).filter(Boolean).length;
      } catch {
        const d = await runCmd(findCmd, ['--type=d', base || '/']);
        folderCount = (d.out || '').split(/\r?\n/).filter(Boolean).length;
      }
      console.log(`[ACCOUNTS] counts files=${fileCount} folders=${folderCount}`);
    } catch (e) {
      console.warn('[ACCOUNTS] find warn:', String(e.message).slice(0,200));
    }

    // Fallbacks de totales y clamps
    if (!storageTotalMB || storageTotalMB <= 0) storageTotalMB = DEFAULT_FREE_QUOTA_MB;
    if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;

    log.verbose(`Métricas crudas id=${id} used=${storageUsedMB}MB total=${storageTotalMB}MB archivos=${fileCount} carpetas=${folderCount}`);
    const updated = await prisma.megaAccount.update({
      where: { id },
      data: {
        status: 'CONNECTED',
        statusMessage: null,
        lastCheckAt: new Date(),
        storageUsedMB,
        storageTotalMB,
        fileCount,
        folderCount,
      },
    });

  log.info(`Prueba cuenta OK id=${id} usado=${storageUsedMB}MB total=${storageTotalMB}MB archivos=${fileCount} carpetas=${folderCount}`);
    return res.json({ message: 'OK', status: 'CONNECTED', account: updated });
  } catch (error) {
  log.error('Error probando cuenta', error.message);
    try {
      const id = Number(req.params.id);
      await prisma.megaAccount.update({ where: { id }, data: { status: 'ERROR', statusMessage: String(error.message).slice(0, 500), lastCheckAt: new Date() } });
    } catch {}
    return res.status(500).json({ message: 'Error testing account', error: String(error.message) });
  } finally {
    // Liberar el flag ANTES de decidir si hay subidas activas
    try { stopUploadsFlag && stopUploadsFlag() } catch {}

    // Si hay subidas activas, no tocamos la sesión global.
    try {
      const { isUploadsActive } = await import('../utils/uploadsActiveFlag.js');
      if (!isUploadsActive()) {
        try { await withMegaLock(() => runCmdWithTimeout('mega-logout', [], MEGA_LOGOUT_TIMEOUT_MS), 'ACCOUNTS-TEST-LOGOUT'); } catch {}
      } else {
        log.warn('[ACCOUNTS][TEST][FINALLY] uploads activos: skip mega-logout');
      }
    } catch {
      // fallback al comportamiento anterior si no podemos cargar helper
      try { await withMegaLock(() => runCmdWithTimeout('mega-logout', [], MEGA_LOGOUT_TIMEOUT_MS), 'ACCOUNTS-TEST-LOGOUT'); } catch {}
    }

    // Si esta llamada aplicó proxy, intentamos limpiar al final (sin afectar subidas activas)
    try {
      if (didSetProxy) await clearMegaProxyIfSafe({ ctx: `accId=${req.params.id}` });
    } catch {}
  }
};

export const getAccountDetail = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const acc = await prisma.megaAccount.findUnique({ where: { id }, include: { credentials: true, backups: { include: { backupAccount: true } }, assignedAsBackup: { include: { mainAccount: true } } } })
    if (!acc) return res.status(404).json({ message: 'Account not found' })
    if (!acc.credentials) return res.status(400).json({ message: 'No credentials stored for this account' })

    const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag)

    const loginCmd = 'mega-login'
    const logoutCmd = 'mega-logout'
    const mkdirCmd = 'mega-mkdir'
    const lsCmd = 'mega-ls'

    let items = []
    const base = (acc.baseFolder || '/').trim()
    await withMegaLock( async () => {
      try { await runCmdWithTimeout(logoutCmd, [], MEGA_LOGOUT_TIMEOUT_MS) } catch {}
      try {
        if (payload?.type === 'session' && payload.session) {
          await runCmdWithTimeout(loginCmd, [payload.session], MEGA_LOGIN_TIMEOUT_MS)
        } else if (payload?.username && payload?.password) {
          await runCmdWithTimeout(loginCmd, [payload.username, payload.password], MEGA_LOGIN_TIMEOUT_MS)
        } else {
          throw new Error('Invalid credentials payload')
        }
      } catch (e) {
        const msg = String(e.message || '').toLowerCase()
        if (!msg.includes('already logged in')) throw e
      }
      if (base && base !== '/') {
        try { await runCmdWithTimeout(mkdirCmd, ['-p', base], MEGA_MKDIR_TIMEOUT_MS) } catch {}
      }
      try {
        const ls = await runCmdWithTimeout(lsCmd, ['-l', base || '/'], MEGA_READONLY_TIMEOUT_MS)
        items = (ls.out || '').split(/\r?\n/).filter(Boolean)
      } catch {}
      try { await runCmdWithTimeout(logoutCmd, [], MEGA_LOGOUT_TIMEOUT_MS) } catch {}
    }, 'ACCOUNTS-DETAIL')

    return res.json({
      account: {
        id: acc.id,
        alias: acc.alias,
        email: acc.email,
        baseFolder: acc.baseFolder,
        type: acc.type,
        status: acc.status,
        statusMessage: acc.statusMessage,
        storageUsedMB: acc.storageUsedMB,
        storageTotalMB: acc.storageTotalMB,
        fileCount: acc.fileCount,
        folderCount: acc.folderCount,
        lastCheckAt: acc.lastCheckAt,
        backups: acc.backups.map(b => ({ id: b.backupAccount.id, alias: b.backupAccount.alias, type: b.backupAccount.type })),
        mains: acc.assignedAsBackup.map(b => ({ id: b.mainAccount.id, alias: b.mainAccount.alias, type: b.mainAccount.type })),
      },
      items,
      itemsCount: items.length,
    })
  } catch (e) {
    console.error('Error getting account detail:', e)
    return res.status(500).json({ message: 'Error getting account detail' })
  }
};

export const addBackupToMain = async (req, res) => {
  try {
    const mainId = Number(req.params.id);
    const { backupAccountId } = req.body;
    if (!backupAccountId) return res.status(400).json({ message: 'backupAccountId requerido' });
    if (mainId === Number(backupAccountId)) return res.status(400).json({ message: 'No se puede asignar la misma cuenta como backup' });
    const main = await prisma.megaAccount.findUnique({ where: { id: mainId }, select: { id: true, type: true } });
    const backup = await prisma.megaAccount.findUnique({ where: { id: Number(backupAccountId) }, select: { id: true, type: true } });
    if (!main || !backup) return res.status(404).json({ message: 'Cuenta main o backup no encontrada' });
    // Opcional: exigir que main sea type=main
    if (main.type !== 'main') return res.status(400).json({ message: 'Solo cuentas type=main pueden tener backups' });
    await prisma.megaAccountBackup.create({ data: { mainAccountId: mainId, backupAccountId: Number(backupAccountId) } });
    return res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('Unique constraint')) {
      return res.status(409).json({ message: 'Ya existe la relación' });
    }
    console.error('[ACCOUNTS] addBackupToMain error', e);
    return res.status(500).json({ message: 'Error asignando backup' });
  }
};

export const removeBackupFromMain = async (req, res) => {
  try {
    const mainId = Number(req.params.id);
    const backupId = Number(req.params.backupId);
    await prisma.megaAccountBackup.deleteMany({ where: { mainAccountId: mainId, backupAccountId: backupId } });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ACCOUNTS] removeBackupFromMain error', e);
    return res.status(500).json({ message: 'Error removiendo backup' });
  }
};

export const listBackupCandidates = async (req, res) => {
  try {
    const mainId = Number(req.params.id);
    const main = await prisma.megaAccount.findUnique({ where: { id: mainId }, select: { id: true, type: true } });
    if (!main) return res.status(404).json({ message: 'Cuenta main no encontrada' });
    if (main.type !== 'main') return res.status(400).json({ message: 'Solo cuentas type=main pueden listar candidatos' });
    // Solo backups que no estén asignados como backup de ninguna main y no estén suspendidos
    const candidates = await prisma.megaAccount.findMany({
      where: {
        type: 'backup',
        id: { not: mainId },
        suspended: false,
        assignedAsBackup: { none: {} }, // No tiene ninguna relación como backup
      },
      select: { id: true, alias: true, email: true, type: true, status: true, suspended: true, lastCheckAt: true },
      orderBy: { alias: 'asc' }
    });
    return res.json({ count: candidates.length, items: candidates });
  } catch (e) {
    console.error('[ACCOUNTS] listBackupCandidates error', e);
    return res.status(500).json({ message: 'Error listando candidatos backup' });
  }
};

export const logoutAccount = async (_req, res) => {
  try {
    console.log('[ACCOUNTS] logout request');
    try { await runCmd('mega-logout', []); console.log('[ACCOUNTS] logout ok'); } catch (e) { console.warn('[ACCOUNTS] logout warn:', String(e.message).slice(0,200)); }
    return res.json({ message: 'Logged out' })
  } catch (e) {
    console.error('[ACCOUNTS] Error logging out:', e);
    return res.status(500).json({ message: 'Error logging out', error: String(e.message) })
  }
};

export const listAccountAssets = async (req, res) => {
  try {
    const id = Number(req.params.id)
    const itemsRaw = await prisma.asset.findMany({
      where: { accountId: id },
      orderBy: { id: 'desc' },
      select: { id: true, title: true, slug: true, fileSizeB: true, archiveSizeB: true, status: true, createdAt: true }
    })
    const items = itemsRaw.map(it => ({
      ...it,
      fileSizeB: it.fileSizeB != null ? Number(it.fileSizeB) : null,
      archiveSizeB: it.archiveSizeB != null ? Number(it.archiveSizeB) : null,
    }))
    return res.json({ count: items.length, items })
  } catch (e) {
    console.error('[ACCOUNTS] listAccountAssets error:', e)
    return res.status(500).json({ message: 'Error listing assets for account' })
  }
};

function normalizeRemotePathForCompare(p) {
  const s = String(p || '').replaceAll('\\', '/').trim();
  if (!s) return '';
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  // Normalizar '..', dobles slashes, etc.
  return path.posix.normalize(withSlash).toLowerCase();
}

function buildExpectedRemoteFilesSet(baseB, assets) {
  const set = new Set();
  for (const a of assets || []) {
    if (!a?.archiveName) continue;
    const fileName = path.basename(a.archiveName);
    const remoteFolder = path.posix.join(baseB, a.slug);
    const remoteFile = path.posix.join(remoteFolder, fileName);
    const norm = normalizeRemotePathForCompare(remoteFile);
    if (norm) set.add(norm);
  }
  return set;
}

async function megaLsExistsWithRetries(remoteFile, { attempts = 2, waitMs = 600, timeoutMs = MEGA_READONLY_TIMEOUT_MS } = {}) {
  let lastErr = null;
  for (let i = 0; i <= attempts; i++) {
    try {
      await runCmdWithTimeout('mega-ls', [remoteFile], timeoutMs);
      return true;
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        await new Promise(r => setTimeout(r, waitMs * (i + 1)));
      }
    }
  }
  // Mantener lastErr para debugging si se necesitara
  void lastErr;
  return false;
}

// Escaneo bulk: ejecuta mega-find una sola vez y sólo guarda matches que están en expectedSet.
// Esto evita N llamadas a mega-ls por asset y reduce las requests de forma masiva.
async function megaFindMatchesExpected(baseB, expectedSet, { timeoutMs = 180000 } = {}) {
  if (!expectedSet || expectedSet.size === 0) return new Set();

  const runOne = (args) => new Promise((resolve, reject) => {
    const child = spawn('mega-find', args, { shell: true });
    let buf = '';
    const found = new Set();
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(to); } catch {}
      if (err) return reject(err);
      return resolve(found);
    };

    const to = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      try { child.kill(); } catch {}
      finish(new Error(`mega-find timeout after ${timeoutMs}ms`));
    }, Math.max(1000, Number(timeoutMs) || 180000));

    const onChunk = (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        const norm = normalizeRemotePathForCompare(line);
        if (norm && expectedSet.has(norm)) {
          found.add(norm);
          // Cortar temprano: si ya encontramos todos los esperados, terminar el proceso.
          if (found.size >= expectedSet.size) {
            try { child.kill('SIGKILL'); } catch {}
            try { child.kill(); } catch {}
            return;
          }
        }
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', () => { /* mega-find a veces usa stderr para logs; ignorar */ });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      // procesar remanente
      try {
        const rem = buf.trim();
        if (rem) {
          const norm = normalizeRemotePathForCompare(rem);
          if (norm && expectedSet.has(norm)) found.add(norm);
        }
      } catch {}
      if (code === 0) return finish();
      // Si lo matamos nosotros para cortar temprano, algunos entornos devuelven code!=0.
      // Aun así, si ya encontramos todos, consideramos OK.
      if (found.size >= expectedSet.size) return finish();
      return finish(new Error(`mega-find exited ${code}`));
    });
  });

  // Orden preferido y fallback por compatibilidad.
  try {
    return await runOne([baseB, '--type=f']);
  } catch {
    return await runOne(['--type=f', baseB]);
  }
}

// Sincroniza todos los assets publicados de una cuenta main hacia sus backups (solo los faltantes)
export const syncMainToBackups = async (req, res) => {
  const mainId = Number(req.params.id);
  try {
    if (!mainId) return res.status(400).json({ message: 'Invalid id' });
    const main = await prisma.megaAccount.findUnique({
      where: { id: mainId },
      include: { credentials: true, backups: { include: { backupAccount: { include: { credentials: true } } } } }
    });
    if (!main) return res.status(404).json({ message: 'Cuenta main no encontrada' });
    if (main.type !== 'main') return res.status(400).json({ message: 'La cuenta no es de tipo main' });

    const backupAccounts = (main.backups || [])
      .map(b => b.backupAccount)
      .filter(a => a && a.type === 'backup' && a.credentials);

    if (!backupAccounts.length) {
      return res.json({ ok: true, message: 'No hay backups asociados', actions: [] });
    }

    // 1. Leer assets publicados (MAIN)
    const assets = await prisma.asset.findMany({
      where: { accountId: mainId, status: 'PUBLISHED' },
      select: { id: true, slug: true, archiveName: true, megaLink: true }
    });

    const logSync = (m, level='info') => {
      if(level==='error') return log.error(m);
      if(level==='warn') return log.warn(m);
      if(level==='verbose') return log.verbose(m);
      return log.info(m);
    };
    logSync(`Sincronización iniciada main=${mainId} assets_publicados=${assets.length} backups=${backupAccounts.length}`);

    if (!assets.length) {
      return res.json({ ok: true, message: 'La cuenta main no tiene assets publicados', actions: [] });
    }

  logSync('Escaneando cuentas backup');
    const assetIds = assets.map(a => a.id);
    const backupIds = backupAccounts.map(b => b.id);
    const replicas = await prisma.assetReplica.findMany({
      where: { assetId: { in: assetIds }, accountId: { in: backupIds } }
    });
    const replicaIndex = new Map();
    for (const r of replicas) replicaIndex.set(`${r.assetId}:${r.accountId}`, r);

    // 2. Escanear cada backup para ver QUÉ FALTA (único criterio)
    const neededPerBackup = new Map(); // backupId -> assets[]
    const scanStats = new Map();       // backupId -> { existing, missing, createdReplicaRows }

    // Helper (nuevo): exportar link público con reintentos (mitiga timing tras mega-put)
    async function exportLinkWithRetries(remoteFile, ctx, attempts = 3, waitMs = 1500) {
      let lastErr = null;
      for (let i = 1; i <= attempts; i++) {
        try {
          const exp = await runCmdWithTimeout('mega-export', ['-a', remoteFile], 15000);
            const all = (exp.out + exp.err) || '';
            const m = all.match(/https?:\/\/mega\.nz\/\S+/i);
            if (m) {
              if (i > 1) logSync(`(IGNORADO LINK) intento=${i} ${ctx}`);
              return m[0];
            }
            lastErr = new Error('No se detectó link en salida');
        } catch (e) {
          lastErr = e; // silencioso
        }
        if (i < attempts) await new Promise(r => setTimeout(r, waitMs));
      }
      return null;
    }

    // (Se reemplaza helper anterior exportPublicLink por esta función adaptadora para escaneo)
    async function exportPublicLink(remoteFile, ctx) {
      return await exportLinkWithRetries(remoteFile, ctx, 3, 1200);
    }

    for (const b of backupAccounts) {
      const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag);
      const baseB = (b.baseFolder || '/').replaceAll('\\', '/');
  logSync(`Backup ${b.id}: escaneo en base ${baseB}`, 'verbose');
      await withMegaLock(async () => {
        try { await runCmd('mega-logout', []); } catch {}
        if (payloadB?.type === 'session' && payloadB.session) await runCmd('mega-login', [payloadB.session]);
        else if (payloadB?.username && payloadB?.password) await runCmd('mega-login', [payloadB.username, payloadB.password]);
        else throw new Error('Credenciales backup inválidas para escaneo');

        try { await runCmd('mega-mkdir', ['-p', baseB]); } catch {}

        scanStats.set(b.id, { existing: 0, missing: 0, createdReplicaRows: 0 });

        // NUEVO: escaneo bulk por backup (1 mega-find) y comparación local.
        // Reduce drásticamente las requests vs mega-ls por archivo.
        const expectedSet = buildExpectedRemoteFilesSet(baseB, assets);
        let foundSet = null;
        try {
          foundSet = await megaFindMatchesExpected(baseB, expectedSet, {
            timeoutMs: Number(process.env.MEGA_BULK_SCAN_TIMEOUT_MS) || 180000,
          });
          logSync(`Backup ${b.id}: bulk-scan OK found=${foundSet.size}/${expectedSet.size}`, 'verbose');
        } catch (e) {
          foundSet = null;
          logSync(`Backup ${b.id}: bulk-scan FAIL -> fallback mega-ls por archivo. err=${String(e.message).slice(0,200)}`, 'warn');
        }

        for (const a of assets) {
          if (!a.archiveName) continue;
            // Comprobación remota directa
          const fileName = path.basename(a.archiveName);
          const remoteFolder = path.posix.join(baseB, a.slug);
          const remoteFile = path.posix.join(remoteFolder, fileName);
          let exists = false;
          if (foundSet) {
            exists = foundSet.has(normalizeRemotePathForCompare(remoteFile));
          } else {
            exists = await megaLsExistsWithRetries(remoteFile, {
              attempts: Number(process.env.MEGA_EXISTS_RETRIES) || 2,
              waitMs: Number(process.env.MEGA_EXISTS_RETRY_WAIT_MS) || 600,
              timeoutMs: MEGA_READONLY_TIMEOUT_MS,
            });
          }

          if (exists) {
            const key = `${a.id}:${b.id}`;
            const remoteFileForExport = remoteFile; // ya definido arriba
            const existingReplica = replicaIndex.get(key);

            if (!existingReplica) {
              // No generar link público (deshabilitado)
              let publicLink = null;
              try {
                const created = await prisma.assetReplica.create({
                  data: {
                    assetId: a.id,
                    accountId: b.id,
                    status: 'COMPLETED',
                    megaLink: ENABLE_PUBLIC_LINK_EXPORT ? (publicLink || undefined) : undefined,
                    remotePath: remoteFolder,
                    startedAt: new Date(),
                    finishedAt: new Date()
                  }
                });
                replicaIndex.set(key, created);
                replicas.push(created); // mantener arreglo coherente
                scanStats.get(b.id).createdReplicaRows++;
                console.log(`[SYNC][SCAN] replica DB creada asset=${a.id} backup=${b.id} link=SKIPPED`);
              } catch (e) {
                console.warn(`[SYNC][SCAN] warn creando replica faltante asset=${a.id} backup=${b.id} : ${e.message}`);
              }
            } else if (!existingReplica.megaLink && ENABLE_PUBLIC_LINK_EXPORT) {
              // Bloque de completar link omitido por desactivación
            }
            scanStats.get(b.id).existing++;
          } else {
            if (!neededPerBackup.has(b.id)) neededPerBackup.set(b.id, []);
            neededPerBackup.get(b.id).push(a);
            scanStats.get(b.id).missing++;
          }
        }
        try { await runCmd('mega-logout', []); } catch {}
      }, `SYNC-SCAN-${b.id}`);

      const st = scanStats.get(b.id);
  logSync(`Backup ${b.id}: archivos presentes=${st.existing} faltantes=${st.missing}`);
    }

    // 3. Calcular total de subidas planeadas (pares asset-backup faltantes)
    const totalUploads = Array.from(neededPerBackup.values())
      .reduce((acc, list) => acc + list.length, 0);

    if (!totalUploads) {
      console.log('[SYNC] No hay uploads necesarios (todos los assets ya existen en backups).');
      return res.json({
        ok: true,
        message: 'Todos los assets ya están replicados',
        actions: [],
        scan: Array.from(scanStats.entries()).map(([backupId, s]) => ({ backupId, ...s })),
        perBackup: [],
        cleanedCacheFiles: 0,
        cleanedCacheDir: true,
        remainingCacheFiles: 0,
        totalUploads,
        performed: 0
      });
    }

  logSync(`Total combinaciones faltantes (asset x backup) = ${totalUploads}`);

    // 4. Conjunto único de assets faltantes (independiente de cuántos backups los requieren)
    const uniqueMissingAssetIds = new Set();
    for (const list of neededPerBackup.values()) {
      for (const a of list) uniqueMissingAssetIds.add(a.id);
    }
    const uniqueMissingAssets = assets.filter(a => uniqueMissingAssetIds.has(a.id));
  logSync(`Assets únicos a descargar: ${uniqueMissingAssets.length}`);

    const UPLOADS_DIR = path.resolve('uploads'); // (solo para consistencia de paths si se quisiera usar; no se reutiliza local permanente)
    const SYNC_DIR = path.join(UPLOADS_DIR, 'sync-cache', `main-${mainId}`);
    fs.mkdirSync(SYNC_DIR, { recursive: true });

    const safeMkdir = async remotePath => {
      try { await runCmd('mega-mkdir', ['-p', remotePath]); }
      catch (e) {
        const msg = String(e.message || '');
        if (!/54/.test(msg) && !/exists/i.test(msg)) throw e;
      }
    };

    // 5. Descargar SIEMPRE desde la cuenta main cada asset faltante (no se inspecciona disco previo)
    const payloadMain = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag);
    await withMegaLock(async () => {
      try { await runCmd('mega-logout', []); } catch {}
      if (payloadMain?.type === 'session' && payloadMain.session) await runCmd('mega-login', [payloadMain.session]);
      else if (payloadMain?.username && payloadMain?.password) await runCmd('mega-login', [payloadMain.username, payloadMain.password]);
      else throw new Error('Credenciales main inválidas para descarga');

      const baseMain = (main.baseFolder || '/').replaceAll('\\', '/');
      await safeMkdir(baseMain);

      let idx = 0;
      for (const a of uniqueMissingAssets) {
        idx++;
        if (!a.archiveName) continue;
        const fileName = path.basename(a.archiveName);
        const remoteFolder = path.posix.join(baseMain, a.slug);
        const remoteFile = path.posix.join(remoteFolder, fileName);
        const slugDir = path.join(SYNC_DIR, a.slug);
        try { fs.mkdirSync(slugDir, { recursive: true }); } catch {}
        const destLocal = path.join(slugDir, fileName);
  logSync(`Descarga ${idx}/${uniqueMissingAssets.length} asset ${a.id} (${a.slug})`,'verbose');
        try {
          await runCmd('mega-get', [remoteFile, destLocal]);
          logSync(`Asset ${a.id} descargado`,'verbose');
        } catch (e) {
          logSync(`Error descargando asset ${a.id}: ${e.message}`,'warn');
        }
      }
      try { await runCmd('mega-logout', []); } catch {}
    }, `SYNC-DOWNLOAD-${mainId}`);

    // 6. Subir a cada backup únicamente lo que le falta
    const actions = [];
    const perBackupUploadStats = [];
    const totalPlanned = totalUploads;
    let globalDone = 0;

    for (const b of backupAccounts) {
      const list = neededPerBackup.get(b.id) || [];
      if (!list.length) continue;

  logSync(`Backup ${b.id}: subidas pendientes ${list.length}`);
      let ok = 0, fail = 0, idx = 0;
      const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag);
      const baseB = (b.baseFolder || '/').replaceAll('\\', '/');

      await withMegaLock(async () => {
        try { await runCmd('mega-logout', []); } catch {}
        if (payloadB?.type === 'session' && payloadB.session) await runCmd('mega-login', [payloadB.session]);
        else if (payloadB?.username && payloadB?.password) await runCmd('mega-login', [payloadB.username, payloadB.password]);
        else throw new Error('Credenciales backup inválidas');

        await safeMkdir(baseB);

        for (const a of list) {
          idx++;
          if (!a.archiveName) { fail++; continue; }
          const fileName = path.basename(a.archiveName);
          const remoteFolder = path.posix.join(baseB, a.slug);
          await safeMkdir(remoteFolder);
          const localPath = path.join(SYNC_DIR, a.slug, fileName); // siempre usamos el descargado recién
          if (!fs.existsSync(localPath)) {
            console.warn(`[SYNC][UPLOAD] archivo temporal no encontrado asset=${a.id} esperado=${localPath}`);
            fail++;
            continue;
          }
          logSync(`Subida ${idx}/${list.length} asset ${a.id} -> backup ${b.id}`,'verbose');
          try {
            await runCmd('mega-put', [localPath, remoteFolder]);
            ok++;
          } catch (e) {
            logSync(`Error subiendo asset ${a.id} a backup ${b.id}: ${e.message}`,'warn');
            fail++;
            continue;
          }
          // No generar link público (deshabilitado)
          let publicLink = null;
          const remoteFile = path.posix.join(remoteFolder, fileName); // mantenido para posible futura reactivación

          const existing = replicas.find(r => r.assetId === a.id && r.accountId === b.id);
          if (!existing) {
            await prisma.assetReplica.create({
              data: {
                assetId: a.id,
                accountId: b.id,
                status: 'COMPLETED',
                megaLink: ENABLE_PUBLIC_LINK_EXPORT ? (publicLink || undefined) : undefined,
                remotePath: path.posix.join(baseB, a.slug),
                startedAt: new Date(),
                finishedAt: new Date()
              }
            });
          } else {
            await prisma.assetReplica.update({
              where: { id: existing.id },
              data: {
                status: 'COMPLETED',
                // Sin generación de link; se conserva el existente si hubiera
                megaLink: ENABLE_PUBLIC_LINK_EXPORT ? (publicLink || existing.megaLink || undefined) : existing.megaLink || undefined,
                remotePath: path.posix.join(baseB, a.slug),
                finishedAt: new Date()
              }
            });
          }
          actions.push({ backupId: b.id, assetId: a.id, status: 'COMPLETED', newLink: false });
          globalDone++;
        }
      }, `SYNC-BACKUP-${b.id}`);

  logSync(`Backup ${b.id}: subidas OK=${ok} errores=${fail}`);
      perBackupUploadStats.push({ backupId: b.id, pending: list.length, ok, fail });
    }

  logSync(`Sincronización finalizada plan=${totalUploads} ejecutadas=${actions.length}`);

    // 7. Limpieza TOTAL (no se conserva nada si SYNC_CACHE_KEEP no es true)
    let cleanedCacheFiles = 0;
    let cleanedCacheDir = false;
    let remainingCacheFiles = 0;
    try {
      const keep = /^(1|true|yes)$/i.test(String(process.env.SYNC_CACHE_KEEP || ''));
      if (fs.existsSync(SYNC_DIR)) {
        const allFiles = [];
        (function walk(dir) {
          for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else allFiles.push(p);
          }
        })(SYNC_DIR);
        remainingCacheFiles = allFiles.length;

        if (!keep) {
          cleanedCacheFiles = remainingCacheFiles;
          try {
            fs.rmSync(SYNC_DIR, { recursive: true, force: true });
            cleanedCacheDir = true;
            remainingCacheFiles = 0;
            logSync('Directorio temporal eliminado','verbose');
          } catch (e) {
            logSync('Error eliminando cache: ' + e.message,'warn');
          }
        } else {
          logSync(`Cache conservada (SYNC_CACHE_KEEP) archivos=${remainingCacheFiles}`);
        }
      }
    } catch (e) {
  logSync('Error en limpieza final: ' + e.message,'warn');
    }

    return res.json({
      ok: true,
      totalUploads,
      performed: actions.length,
      actions,
      scan: Array.from(scanStats.entries()).map(([backupId, s]) => ({ backupId, ...s })),
      perBackup: perBackupUploadStats,
      cleanedCacheFiles,
      cleanedCacheDir,
      remainingCacheFiles
    });
  } catch (e) {
  logSync('Error general en sincronización: ' + e.message,'error');
    return res.status(500).json({ message: 'Error sincronizando', error: e.message });
  }
};

// (Añadir cerca de otras constantes)
const MEGA_EXPORT_ATTEMPTS = Number(process.env.MEGA_EXPORT_ATTEMPTS || 5);
const MEGA_EXPORT_BASE_TIMEOUT_MS = Number(process.env.MEGA_EXPORT_BASE_TIMEOUT_MS || 20000);

// Helper: sleep
const wait = ms => new Promise(r => setTimeout(r, ms));

// Nuevo helper robusto: obtiene o crea link público con reintentos y backoff
async function getOrCreatePublicLink(remoteFile, ctx) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MEGA_EXPORT_ATTEMPTS; attempt++) {
    const timeout = Math.round(MEGA_EXPORT_BASE_TIMEOUT_MS * (1 + (attempt - 1) * 0.6)); // creciente
    try {
      // 1. Intentar leer link existente (sin -a)
      try {
        console.log(`[SYNC][EXPORT][TRY-GET] intento=${attempt}/${MEGA_EXPORT_ATTEMPTS} timeout=${timeout}ms ${ctx}`);
        const exp = await runCmdWithTimeout('mega-export', [remoteFile], timeout);
        const raw = (exp.out + exp.err) || '';
        const mGet = raw.match(/https?:\/\/mega\.nz\/\S+/i);
        if (mGet) {
          console.log(`[SYNC][EXPORT][FOUND] link existente ${ctx}`);
          return mGet[0];
        }
      } catch (e1) {
        // Registrar pero continuar a creación
        console.warn(`[SYNC][EXPORT][NO-EXISTE] ${ctx} intento=${attempt}: ${e1.message}`);
      }

      // 2. Crear link (-a)
        console.log(`[SYNC][EXPORT][CREATE] intento=${attempt}/${MEGA_EXPORT_ATTEMPTS} timeout=${timeout}ms ${ctx}`);
      const expCreate = await runCmdWithTimeout('mega-export', ['-a', remoteFile], timeout);
      const all = (expCreate.out + expCreate.err) || '';
      const m = all.match(/https?:\/\/mega\.nz\/\S+/i);
      if (m) {
        console.log(`[SYNC][EXPORT][OK] creado ${ctx}`);
        return m[0];
      }
      lastErr = new Error('Salida sin link');
    } catch (e) {
      lastErr = e;
      console.warn(`[SYNC][EXPORT][WARN] intento=${attempt}/${MEGA_EXPORT_ATTEMPTS} ${ctx}: ${e.message}`);
    }
    if (attempt < MEGA_EXPORT_ATTEMPTS) {
      const backoff = 1000 + attempt * 1500;
      console.log(`[SYNC][EXPORT][WAIT] ${backoff}ms antes de reintentar ${ctx}`);
      await wait(backoff);
    }
  }
  console.warn(`[SYNC][EXPORT][FAIL] sin link tras ${MEGA_EXPORT_ATTEMPTS} intentos ${ctx} lastErr=${lastErr?.message}`);
  return null;
}

// Adaptador para llamadas desde escaneo (mantiene nombre previo para mínimo cambio)
async function exportPublicLink(remoteFile, ctx) {
  return await getOrCreatePublicLink(remoteFile, ctx);
}

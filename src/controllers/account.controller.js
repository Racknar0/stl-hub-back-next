import { PrismaClient } from '@prisma/client';
import { encryptJson, decryptToJson } from '../utils/cryptoUtils.js';
import { spawn } from 'child_process';
import { withMegaLock } from '../utils/megaQueue.js';
import path from 'path';
import fs from 'fs';

const prisma = new PrismaClient();
// Cuota por defecto para cuentas gratuitas de MEGA (MB). Se puede sobreescribir con MEGA_FREE_QUOTA_MB
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480;
// Cuota de transferencia por defecto (si no se puede leer de mega-df). Se puede sobreescribir con MEGA_FREE_BW_MB
const DEFAULT_FREE_BW_MB = Number(process.env.MEGA_FREE_BW_MB) || 20480;

// Límite máximo de captura para evitar RangeError por acumulación de salida
const MAX_CMD_CAPTURE_BYTES = (Number(process.env.MEGA_MAX_CAPTURE_KB) || 1024) * 1024; // 1MB por defecto

// Ejecuta un comando y devuelve stdout/err con logs (sin exponer credenciales) limitando tamaño
function runCmd(cmd, args = [], { cwd, maxBytes } = {}) {
  const maskArgs = (c, a) => (c && c.toLowerCase().includes('mega-login') ? ['<hidden>'] : a);
  const printable = `${cmd} ${(maskArgs(cmd, args) || []).join(' ')}`.trim();
  console.log(`[MEGA] > ${printable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: true });
    let out = '', err = '';
    const limit = maxBytes || MAX_CMD_CAPTURE_BYTES;
    let truncatedOut = false, truncatedErr = false;
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
    child.on('close', (code) => {
      if (code === 0) {
        if (out?.trim()) console.log(`[MEGA] < ${cmd} ok (${out.length} chars out${truncatedOut ? ' TRUNCATED' : ''})`);
        else if (err?.trim()) console.log(`[MEGA] < ${cmd} ok (stderr ${err.length} chars${truncatedErr ? ' TRUNCATED' : ''})`);
        else console.log(`[MEGA] < ${cmd} ok (no output)`);
        return resolve({ out, err, truncatedOut, truncatedErr });
      }
      console.error(`[MEGA] x ${cmd} exit ${code}. err:`, (err || out || '').slice(0, 500));
      reject(new Error(err || out || `${cmd} exited with code ${code}`));
    });
  });
}

// Ejecuta comando con timeout (mata el proceso si excede)
async function runCmdWithTimeout(cmd, args = [], timeoutMs = 15000, options = {}) {
  const maskArgs = (c, a) => (c && c.toLowerCase().includes('mega-login') ? ['<hidden>'] : a)
  const printable = `${cmd} ${(maskArgs(cmd, args) || []).join(' ')}`.trim()
  console.log(`[MEGA] > ${printable} (timeout ${timeoutMs}ms)`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true, cwd: options.cwd })
    let out = '', err = ''
    const limit = options.maxBytes || MAX_CMD_CAPTURE_BYTES
    let truncatedOut = false, truncatedErr = false
    const to = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      console.warn(`[MEGA] x ${cmd} timeout tras ${timeoutMs}ms`)
      reject(new Error(`${cmd} timeout`))
    }, timeoutMs)
    child.stdout.on('data', d => {
      if (!truncatedOut) {
        if (out.length + d.length <= limit) out += d.toString();
        else { const slice = limit - out.length; if (slice > 0) out += d.toString().slice(0, slice); truncatedOut = true }
      }
    })
    child.stderr.on('data', d => {
      if (!truncatedErr) {
        if (err.length + d.length <= limit) err += d.toString();
        else { const slice = limit - err.length; if (slice > 0) err += d.toString().slice(0, slice); truncatedErr = true }
      }
    })
    child.on('close', code => {
      clearTimeout(to)
      if (code === 0) return resolve({ out, err, truncatedOut, truncatedErr })
      reject(new Error(err || out || `${cmd} exited ${code}`))
    })
  })
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

// Test de conexión ligero: login y ls baseFolder
export const testAccount = async (req, res) => {
  let didLogin = false;
  try {
    const id = Number(req.params.id);
    console.log(`[ACCOUNTS] testAccount id=${id}`);
    const acc = await prisma.megaAccount.findUnique({ where: { id }, include: { credentials: true } });
    if (!acc) return res.status(404).json({ message: 'Account not found' });
    if (!acc.credentials) return res.status(400).json({ message: 'No credentials stored for this account' });
    console.log(`[ACCOUNTS] account alias=${acc.alias} email=${acc.email} base=${acc.baseFolder}`);

    const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag);

    const loginCmd = 'mega-login';
    const logoutCmd = 'mega-logout';
    const mkdirCmd = 'mega-mkdir';
    const dfCmd = 'mega-df';
    const duCmd = 'mega-du';
    const findCmd = 'mega-find';

    const base = (acc.baseFolder || '/').trim();
    await withMegaLock(async () => {
      // Limpiar sesiones previas
      try { await runCmd(logoutCmd, []); console.log('[ACCOUNTS] pre-logout ok'); } catch (e) { console.warn('[ACCOUNTS] pre-logout warn:', String(e.message).slice(0,200)); }
      // Login
      try {
        if (payload?.type === 'session' && payload.session) {
          console.log('[ACCOUNTS] login with session');
          await runCmd(loginCmd, [payload.session]);
        } else if (payload?.username && payload?.password) {
          console.log('[ACCOUNTS] login with user');
          await runCmd(loginCmd, [payload.username, payload.password]);
        } else {
          throw new Error('Invalid credentials payload');
        }
        didLogin = true; console.log('[ACCOUNTS] login ok');
      } catch (e) {
        const msg = String(e.message || '').toLowerCase();
        console.error('[ACCOUNTS] login error:', msg);
        if (!msg.includes('already logged in')) { throw e }
      }
      console.log(`[ACCOUNTS] ensure base folder: ${base}`);
      if (base && base !== '/') {
        try { await runCmd(mkdirCmd, ['-p', base]); console.log('[ACCOUNTS] mkdir ok'); } catch (e) { console.warn('[ACCOUNTS] mkdir warn:', String(e.message).slice(0,200)); }
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
    if (!storageTotalMB || storageTotalMB <= 0) {
      storageTotalMB = DEFAULT_FREE_QUOTA_MB;
      console.log(`[ACCOUNTS] fallback totalMB to FREE QUOTA: ${storageTotalMB}`);
    }
    if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;

    // Actualizar estado y métricas (sin ancho de banda)
    console.log(`[ACCOUNTS] update metrics id=${id} used=${storageUsedMB}MB total=${storageTotalMB}MB files=${fileCount} folders=${folderCount}`);
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

    console.log('[ACCOUNTS] testAccount OK');
    return res.json({ message: 'OK', status: 'CONNECTED', account: updated });
  } catch (error) {
    console.error('[ACCOUNTS] Error testing account:', error);
    try {
      const id = Number(req.params.id);
      await prisma.megaAccount.update({ where: { id }, data: { status: 'ERROR', statusMessage: String(error.message).slice(0, 500), lastCheckAt: new Date() } });
    } catch {}
    return res.status(500).json({ message: 'Error testing account', error: String(error.message) });
  } finally {
    try { await withMegaLock(() => runCmd('mega-logout', []), 'ACCOUNTS-TEST-LOGOUT'); console.log('[ACCOUNTS] final logout ok'); } catch (e) { console.warn('[ACCOUNTS] final logout warn:', String(e.message).slice(0,200)); }
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
      try { await runCmd(logoutCmd, []) } catch {}
      try {
        if (payload?.type === 'session' && payload.session) {
          await runCmd(loginCmd, [payload.session])
        } else if (payload?.username && payload?.password) {
          await runCmd(loginCmd, [payload.username, payload.password])
        } else {
          throw new Error('Invalid credentials payload')
        }
      } catch (e) {
        const msg = String(e.message || '').toLowerCase()
        if (!msg.includes('already logged in')) throw e
      }
      if (base && base !== '/') {
        try { await runCmd(mkdirCmd, ['-p', base]) } catch {}
      }
      try {
        const ls = await runCmd(lsCmd, ['-l', base || '/'])
        items = (ls.out || '').split(/\r?\n/).filter(Boolean)
      } catch {}
      try { await runCmd(logoutCmd, []) } catch {}
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
    const existing = await prisma.megaAccountBackup.findMany({ where: { mainAccountId: mainId }, select: { backupAccountId: true } });
    const existingIds = new Set(existing.map(e => e.backupAccountId));
    const candidates = await prisma.megaAccount.findMany({
      where: { type: 'backup', id: { not: mainId } },
      select: { id: true, alias: true, email: true, type: true, status: true, suspended: true, lastCheckAt: true },
      orderBy: { alias: 'asc' }
    });
    const filtered = candidates.filter(c => !existingIds.has(c.id) && !c.suspended);
    return res.json({ count: filtered.length, items: filtered });
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
    const items = await prisma.asset.findMany({
      where: { accountId: id },
      orderBy: { id: 'desc' },
      select: { id: true, title: true, slug: true, fileSizeB: true, archiveSizeB: true, status: true, createdAt: true }
    })
    return res.json({ count: items.length, items })
  } catch (e) {
    console.error('[ACCOUNTS] listAccountAssets error:', e)
    return res.status(500).json({ message: 'Error listing assets for account' })
  }
};

// Sincroniza todos los assets publicados de una cuenta main hacia sus backups (solo los faltantes)
export const syncMainToBackups = async (req, res) => {
  const mainId = Number(req.params.id)
  try {
    if (!mainId) return res.status(400).json({ message: 'Invalid id' })
    const main = await prisma.megaAccount.findUnique({
      where: { id: mainId },
      include: { credentials: true, backups: { include: { backupAccount: { include: { credentials: true } } } } }
    })
    if (!main) return res.status(404).json({ message: 'Cuenta main no encontrada' })
    if (main.type !== 'main') return res.status(400).json({ message: 'La cuenta no es de tipo main' })
    const backupAccounts = (main.backups || []).map(b => b.backupAccount).filter(a => a && a.type === 'backup' && a.credentials)
    if (!backupAccounts.length) return res.json({ ok: true, message: 'No hay backups asociados', actions: [] })

    const assets = await prisma.asset.findMany({
      where: { accountId: mainId, status: 'PUBLISHED' },
      select: { id: true, slug: true, archiveName: true, megaLink: true }
    })
    if (!assets.length) return res.json({ ok: true, message: 'La cuenta main no tiene assets publicados', actions: [] })

    console.log(`[SYNC] === INICIO sync main->backups mainId=${mainId} assetsPublicados=${assets.length} backups=${backupAccounts.length} ===`)
    const assetIds = assets.map(a => a.id)
    const backupIds = backupAccounts.map(b => b.id)
    const replicas = await prisma.assetReplica.findMany({ where: { assetId: { in: assetIds }, accountId: { in: backupIds } } })
    const replicaIndex = new Map()
    for (const r of replicas) replicaIndex.set(`${r.assetId}:${r.accountId}`, r)

    const neededPerBackup = new Map()
    const scanStats = new Map()
    for (const b of backupAccounts) {
      const payloadB = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
      const baseB = (b.baseFolder || '/').replaceAll('\\', '/')
      console.log(`[SYNC][SCAN] inicio backup=${b.id} base=${baseB}`)
      await withMegaLock(async () => {
        try { await runCmd('mega-logout', []) } catch {}
        if (payloadB?.type === 'session' && payloadB.session) await runCmd('mega-login', [payloadB.session])
        else if (payloadB?.username && payloadB?.password) await runCmd('mega-login', [payloadB.username, payloadB.password])
        else throw new Error('Credenciales backup inválidas para escaneo')
        try { await runCmd('mega-mkdir', ['-p', baseB]) } catch {}
        scanStats.set(b.id, { existing: 0, missing: 0, createdReplicaRows: 0 })
        for (const a of assets) {
          if (!a.archiveName) continue
          const fileName = path.basename(a.archiveName)
          const remoteFolder = path.posix.join(baseB, a.slug)
          const remoteFile = path.posix.join(remoteFolder, fileName)
          let exists = false
          try {
            const ls = await runCmd('mega-ls', [remoteFile])
            const txt = (ls.out || ls.err || '').toString()
            if (txt.toLowerCase().includes(fileName.toLowerCase())) exists = true
            else exists = true
          } catch { exists = false }
          if (exists) {
            const key = `${a.id}:${b.id}`
            if (!replicaIndex.has(key)) {
              try {
                const created = await prisma.assetReplica.create({ data: { assetId: a.id, accountId: b.id, status: 'COMPLETED', remotePath: remoteFolder, startedAt: new Date(), finishedAt: new Date() } })
                replicaIndex.set(key, created)
                scanStats.get(b.id).createdReplicaRows++
                console.log(`[SYNC][SCAN] replica DB creada asset=${a.id} backup=${b.id}`)
              } catch (e) {
                console.warn('[SYNC][SCAN] warn creando replica faltante asset=' + a.id + ' backup=' + b.id + ' : ' + e.message)
              }
            }
            scanStats.get(b.id).existing++
            if (scanStats.get(b.id).existing <= 5) console.log(`[SYNC][SCAN] existe asset=${a.id} backup=${b.id}`)
          } else {
            if (!neededPerBackup.has(b.id)) neededPerBackup.set(b.id, [])
            neededPerBackup.get(b.id).push(a)
            scanStats.get(b.id).missing++
            if (scanStats.get(b.id).missing <= 5) console.log(`[SYNC][SCAN] falta asset=${a.id} backup=${b.id}`)
          }
        }
        try { await runCmd('mega-logout', []) } catch {}
      }, `SYNC-SCAN-${b.id}`)
      const st = scanStats.get(b.id)
      console.log(`[SYNC][SCAN] resumen backup=${b.id} existing=${st.existing} missing=${st.missing} createdReplicaRows=${st.createdReplicaRows}`)
    }

    const totalUploads = Array.from(neededPerBackup.values()).reduce((acc, list) => acc + list.length, 0)
    if (!totalUploads) {
      console.log('[SYNC] No hay uploads necesarios tras escaneo físico')
      return res.json({ ok: true, message: 'Todos los assets ya están físicamente replicados', actions: [], scan: Array.from(scanStats.entries()).map(([backupId, s]) => ({ backupId, ...s })) })
    }

    const UPLOADS_DIR = path.resolve('uploads')
    const SYNC_DIR = path.join(UPLOADS_DIR, 'sync-cache', `main-${mainId}`)
    fs.mkdirSync(SYNC_DIR, { recursive: true })

    function localArchivePath(a) {
      if (!a.archiveName) return null
      return path.join(UPLOADS_DIR, a.archiveName.startsWith('archives') ? a.archiveName : path.join('archives', a.archiveName))
    }

    const assetsToDownload = []
    const neededAssetSet = new Set()
    for (const list of neededPerBackup.values()) for (const a of list) neededAssetSet.add(a.id)
    const neededAssets = assets.filter(a => neededAssetSet.has(a.id))
    for (const a of neededAssets) {
      const localPath = localArchivePath(a)
      if (!localPath) continue
      if (!fs.existsSync(localPath)) assetsToDownload.push(a)
    }
    console.log(`[SYNC][DOWNLOAD] faltanLocal=${assetsToDownload.length} deFaltantes=${neededAssets.length}`)

    const safeMkdir = async (remotePath) => {
      try { await runCmd('mega-mkdir', ['-p', remotePath]) } catch (e) {
        const msg = String(e.message || '')
        if (!/54/.test(msg) && !/exists/i.test(msg)) throw e
      }
    }

    if (assetsToDownload.length) {
      const payload = decryptToJson(main.credentials.encData, main.credentials.encIv, main.credentials.encTag)
      const base = (main.baseFolder || '/').replaceAll('\\', '/')
      await withMegaLock(async () => {
        try { await runCmd('mega-logout', []) } catch {}
        if (payload?.type === 'session' && payload.session) await runCmd('mega-login', [payload.session])
        else if (payload?.username && payload?.password) await runCmd('mega-login', [payload.username, payload.password])
        else throw new Error('Credenciales main inválidas')
        await safeMkdir(base)
        for (const a of assetsToDownload) {
          const fileName = path.basename(a.archiveName)
          const remoteFolder = path.posix.join(base, a.slug)
          const remoteFile = path.posix.join(remoteFolder, fileName)
          const slugDir = path.join(SYNC_DIR, a.slug)
          try { fs.mkdirSync(slugDir, { recursive: true }) } catch {}
          const destLocal = path.join(slugDir, fileName)
          console.log(`[SYNC][DOWNLOAD] asset=${a.id} remoteFile=${remoteFile} -> ${destLocal}`)
          try { await runCmd('mega-get', [remoteFile, destLocal]); console.log(`[SYNC][DOWNLOAD] OK asset=${a.id}`) } catch (e) { console.warn('[SYNC][DOWNLOAD] WARN asset=' + a.id + ' : ' + e.message) }
        }
        try { await runCmd('mega-logout', []) } catch {}
      }, `SYNC-DOWNLOAD-${mainId}`)
    }

    const actions = []
    const perBackupUploadStats = []
    const totalPlanned = totalUploads
    let globalDone = 0
    // Conteo de subidas pendientes por asset (solo para los que realmente faltan en backups)
    const remainingUploads = new Map()
    for (const list of neededPerBackup.values()) {
      for (const a of list) {
        remainingUploads.set(a.id, (remainingUploads.get(a.id) || 0) + 1)
      }
    }
    let cleanedCount = 0
    for (const b of backupAccounts) {
      const list = neededPerBackup.get(b.id) || []
      if (!list.length) continue
      console.log(`[SYNC][UPLOAD] inicio backup=${b.id} pendientes=${list.length} globalDone=${globalDone}/${totalPlanned}`)
      let ok = 0, fail = 0, idx = 0
      const payload = decryptToJson(b.credentials.encData, b.credentials.encIv, b.credentials.encTag)
      const base = (b.baseFolder || '/').replaceAll('\\', '/')
      await withMegaLock(async () => {
        try { await runCmd('mega-logout', []) } catch {}
        if (payload?.type === 'session' && payload.session) await runCmd('mega-login', [payload.session])
        else if (payload?.username && payload?.password) await runCmd('mega-login', [payload.username, payload.password])
        else throw new Error('Credenciales backup inválidas')
        await safeMkdir(base)
        for (const a of list) {
          idx++
          const fileName = path.basename(a.archiveName || '')
          if (!fileName) continue
          const remoteFolder = path.posix.join(base, a.slug)
          await safeMkdir(remoteFolder)
          const localPathOrig = localArchivePath(a)
          let localToUse = localPathOrig && fs.existsSync(localPathOrig) ? localPathOrig : null
          if (!localToUse) {
            const cached = path.join(SYNC_DIR, a.slug, fileName)
            if (fs.existsSync(cached)) localToUse = cached
          }
          if (!localToUse) { console.warn('[SYNC][UPLOAD] no local file for asset', a.id); fail++; continue }
          console.log(`[SYNC][UPLOAD] asset=${a.id} -> backup=${b.id} (${idx}/${list.length}) global(${globalDone}/${totalPlanned})`)
          try {
            await runMegaPutWithProgress(localToUse, remoteFolder, { assetId: a.id, backupId: b.id, index: idx, total: list.length, globalDone, totalPlanned })
            ok++
          } catch (e) { console.warn('[SYNC][SUBIDA] WARN asset=' + a.id + ' backup=' + b.id + ' : ' + e.message); fail++; continue }
          let publicLink = null
          try {
            const remoteFile = path.posix.join(remoteFolder, path.basename(localToUse))
            console.log(`[SYNC][EXPORT] iniciando asset=${a.id} backup=${b.id}`)
            const exp = await runCmdWithTimeout('mega-export', ['-a', remoteFile], 15000)
            const all = (exp.out + exp.err) || ''
            const m = all.match(/https?:\/\/mega\.nz\/\S+/i)
            if (m) publicLink = m[0]
            console.log(`[SYNC][EXPORT] ok asset=${a.id} backup=${b.id}`)
          } catch (e) { console.warn('[SYNC][EXPORT] aviso asset=' + a.id + ' backup=' + b.id + ' : ' + e.message) }
          const existing = replicas.find(r => r.assetId === a.id && r.accountId === b.id)
          if (!existing) {
            await prisma.assetReplica.create({ data: { assetId: a.id, accountId: b.id, status: 'COMPLETED', megaLink: publicLink || undefined, remotePath: path.posix.join(base, a.slug), startedAt: new Date(), finishedAt: new Date() } })
          } else {
            await prisma.assetReplica.update({ where: { id: existing.id }, data: { status: 'COMPLETED', megaLink: publicLink || existing.megaLink || undefined, remotePath: path.posix.join(base, a.slug), finishedAt: new Date() } })
          }
          actions.push({ backupId: b.id, assetId: a.id, status: 'COMPLETED' })
          globalDone++
          // Decrementar contador y limpiar cache si ya no se necesita
          if (remainingUploads.has(a.id)) {
            const left = remainingUploads.get(a.id) - 1
            remainingUploads.set(a.id, left)
            if (left <= 0) {
              const fileNameCached = path.basename(a.archiveName || '')
              if (fileNameCached) {
                const cachedPath = path.join(SYNC_DIR, a.slug, fileNameCached)
                try {
                  if (fs.existsSync(cachedPath)) {
                    fs.unlinkSync(cachedPath)
                    cleanedCount++
                    console.log(`[SYNC][CLEAN] cache eliminado asset=${a.id} path=${cachedPath}`)
                    // Intentar limpiar carpeta slug si queda vacía
                    const slugDir = path.join(SYNC_DIR, a.slug)
                    try { if (fs.existsSync(slugDir) && fs.readdirSync(slugDir).length === 0) fs.rmdirSync(slugDir) } catch {}
                  }
                } catch (e) {
                  console.warn('[SYNC][CLEAN] warn al borrar cache asset=' + a.id + ' : ' + e.message)
                }
              }
            }
          }
        }
        try { await runCmd('mega-logout', []) } catch {}
      }, `SYNC-BACKUP-${b.id}`)
      console.log(`[SYNC][UPLOAD] fin backup=${b.id} ok=${ok} fail=${fail} globalDone=${globalDone}/${totalPlanned}`)
      perBackupUploadStats.push({ backupId: b.id, pending: list.length, ok, fail })
    }
  console.log(`[SYNC] === FIN sync mainId=${mainId} planUploads=${totalUploads} realizadas=${actions.length} ===`)
  console.log(`[SYNC][FIN] Sincronización completada mainId=${mainId} uploadsRealizadas=${actions.length} backups=${backupAccounts.length}`)
    // Limpieza final de la carpeta de sincronización si está vacía (a menos que se pida conservar)
    let cleanedCacheDir = false
    let remainingCacheFilesCount = 0
    try {
      if (fs.existsSync(SYNC_DIR)) {
        const keep = /^(1|true|yes)$/i.test(String(process.env.SYNC_CACHE_KEEP || ''))
        const remaining = fs.readdirSync(SYNC_DIR)
        remainingCacheFilesCount = remaining.length
        if (keep) {
          console.log(`[SYNC][CLEAN] se conserva SYNC_DIR por SYNC_CACHE_KEEP restante=${remaining.length}`)
        } else if (remaining.length === 0) {
          try { fs.rmdirSync(SYNC_DIR) } catch {}
          cleanedCacheDir = true
          console.log(`[SYNC][CLEAN] carpeta vacía eliminada SYNC_DIR=${SYNC_DIR}`)
          // Intentar eliminar el contenedor main-* si quedó vacío (ya es la misma carpeta en este diseño)
          const parent = path.dirname(SYNC_DIR)
          try {
            const restParent = fs.readdirSync(parent)
            if (restParent.length === 0) {
              try { fs.rmdirSync(parent) } catch {}
            }
          } catch {}
        } else {
          console.log(`[SYNC][CLEAN] carpeta no vacía, se mantiene archivos=${remaining.length}`)
        }
      }
    } catch (e2) {
      console.warn('[SYNC][CLEAN] error al evaluar limpieza final: ' + e2.message)
    }
    return res.json({ ok: true, totalUploads, performed: actions.length, actions, scan: Array.from(scanStats.entries()).map(([backupId, s]) => ({ backupId, ...s })), perBackup: perBackupUploadStats, cleanedCacheFiles: cleanedCount, cleanedCacheDir, remainingCacheFiles: remainingCacheFilesCount })
  } catch (e) {
    console.error('[SYNC] main->backups error:', e)
    return res.status(500).json({ message: 'Error sincronizando', error: e.message })
  }
}

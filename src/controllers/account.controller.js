import { PrismaClient } from '@prisma/client';
import { encryptJson, decryptToJson } from '../utils/cryptoUtils.js';
import { spawn } from 'child_process';

const prisma = new PrismaClient();
// Cuota por defecto para cuentas gratuitas de MEGA (MB). Se puede sobreescribir con MEGA_FREE_QUOTA_MB
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480;
// Cuota de transferencia por defecto (si no se puede leer de mega-df). Se puede sobreescribir con MEGA_FREE_BW_MB
const DEFAULT_FREE_BW_MB = Number(process.env.MEGA_FREE_BW_MB) || 20480;

// Ejecuta un comando y devuelve stdout/err con logs (sin exponer credenciales)
function runCmd(cmd, args = [], { cwd } = {}) {
  const maskArgs = (c, a) => (c && c.toLowerCase().includes('mega-login') ? ['<hidden>'] : a);
  const printable = `${cmd} ${(maskArgs(cmd, args) || []).join(' ')}`.trim();
  console.log(`[MEGA] > ${printable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => err += d.toString());
    child.on('close', (code) => {
      if (code === 0) {
        if (out?.trim()) console.log(`[MEGA] < ${cmd} ok (${out.length} chars out)`);
        else if (err?.trim()) console.log(`[MEGA] < ${cmd} ok (stderr ${err.length} chars)`);
        else console.log(`[MEGA] < ${cmd} ok (no output)`);
        return resolve({ out, err });
      }
      console.error(`[MEGA] x ${cmd} exit ${code}. err:`, (err || out || '').slice(0, 500));
      reject(new Error(err || out || `${cmd} exited with code ${code}`));
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
        return res.status(400).json({ message: 'Invalid credentials payload' });
      }
      didLogin = true;
      console.log('[ACCOUNTS] login ok');
    } catch (e) {
      const msg = String(e.message || '').toLowerCase();
      console.error('[ACCOUNTS] login error:', msg);
      if (!msg.includes('already logged in')) { throw e }
    }

    // Asegurar carpeta base
    const base = (acc.baseFolder || '/').trim();
    console.log(`[ACCOUNTS] ensure base folder: ${base}`);
    if (base && base !== '/') {
      try { await runCmd(mkdirCmd, ['-p', base]); console.log('[ACCOUNTS] mkdir ok'); } catch (e) { console.warn('[ACCOUNTS] mkdir warn:', String(e.message).slice(0,200)); }
    }

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
    try { await runCmd('mega-logout', []); console.log('[ACCOUNTS] final logout ok'); } catch (e) { console.warn('[ACCOUNTS] final logout warn:', String(e.message).slice(0,200)); }
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

    // limpiar sesión previa
    try { await runCmd(logoutCmd, []) } catch {}

    // login
    try {
      if (payload?.type === 'session' && payload.session) {
        await runCmd(loginCmd, [payload.session])
      } else if (payload?.username && payload?.password) {
        await runCmd(loginCmd, [payload.username, payload.password])
      } else {
        return res.status(400).json({ message: 'Invalid credentials payload' })
      }
    } catch (e) {
      const msg = String(e.message || '').toLowerCase()
      if (!msg.includes('already logged in')) throw e
    }

    const base = (acc.baseFolder || '/').trim()
    if (base && base !== '/') {
      try { await runCmd(mkdirCmd, ['-p', base]) } catch {}
    }

    // Listar items
    let items = []
    try {
      const ls = await runCmd(lsCmd, ['-l', base || '/'])
      items = (ls.out || '').split(/\r?\n/).filter(Boolean)
    } catch {}

    // cerrar sesión
    try { await runCmd(logoutCmd, []) } catch {}

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

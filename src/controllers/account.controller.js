import { PrismaClient } from '@prisma/client';
import { encryptJson, decryptToJson } from '../utils/cryptoUtils.js';
import { spawn } from 'child_process';

const prisma = new PrismaClient();
// Cuota por defecto para cuentas gratuitas de MEGA (MB). Se puede sobreescribir con MEGA_FREE_QUOTA_MB
const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480;

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
    const [accounts] = await Promise.all([
      prisma.megaAccount.findMany({
        orderBy: { priority: 'asc' },
        select: {
          id: true,
          alias: true,
          email: true,
          baseFolder: true,
          priority: true,
          status: true,
          statusMessage: true,
          suspended: true,
          storageUsedMB: true,
          storageTotalMB: true,
          bandwidthUsedMB: true,
          bandwidthPeriodAt: true,
          errors24h: true,
          lastCheckAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      // prisma.megaAccount.count(), // para futura paginación
    ])
    return res.json(accounts)
  } catch (error) {
    console.error('Error listing accounts:', error);
    return res.status(500).json({ message: 'Error listing accounts' });
  }
};

export const createAccount = async (req, res) => {
  try {
    const { alias, email, baseFolder, priority = 1, credentials } = req.body;
    console.log(`[ACCOUNTS] create alias=${alias} email=${email} base=${baseFolder} priority=${priority}`);
    if (!alias || !email || !baseFolder || !credentials) {
      return res.status(400).json({ message: 'alias, email, baseFolder y credentials son requeridos' });
    }
    const account = await prisma.megaAccount.create({ data: { alias, email, baseFolder, priority, status: 'ERROR' } });
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
    const { alias, email, baseFolder, priority, suspended, status } = req.body;

    const data = {};
    if (alias !== undefined) data.alias = alias;
    if (email !== undefined) data.email = email;
    if (baseFolder !== undefined) data.baseFolder = baseFolder;
    if (priority !== undefined) data.priority = Number(priority);
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

    // Métricas con mega-df -h (la versión instalada no soporta --json)
    let storageUsedMB = 0, storageTotalMB = 0;
    try {
      const dfTxt = await runCmd(dfCmd, ['-h']);
      const txt = (dfTxt.out || dfTxt.err || '').toString();
      // Patrones posibles
      // EN: "Account storage: <used> / <total>", "Storage: <used> of <total>", generic "<used>/<total>"
      // ES: "Almacenamiento de la cuenta: <used> de <total>", "Almacenamiento: <used> de <total>"
      let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
           || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
           || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
           || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
           || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);
      if (m) {
        storageUsedMB = parseSizeToMB(m[1]);
        storageTotalMB = parseSizeToMB(m[2]);
      }
      console.log(`[ACCOUNTS] df -h usedMB=${storageUsedMB} totalMB=${storageTotalMB}`);
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
        console.log(`[ACCOUNTS] df usedMB=${storageUsedMB} totalMB=${storageTotalMB}`);
      } catch (e) {
        console.warn('[ACCOUNTS] df warn:', String(e.message).slice(0,200));
      }
    }

    if (!storageTotalMB) {
      try {
        const duRes = await runCmd(duCmd, ['-h', base || '/']);
        const lines = (duRes.out || '').trim().split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1] || '';
        const m = last.match(/([\d.,]+\s*[KMGT]?B)/i);
        if (m) storageUsedMB = parseSizeToMB(m[1]);
        console.log(`[ACCOUNTS] du usedMB=${storageUsedMB}`);
      } catch (e) {
        console.warn('[ACCOUNTS] du warn:', String(e.message).slice(0,200));
      }
    }

    // Fallback: todas las cuentas son gratuitas => usar cuota por defecto si el total no se obtuvo
    if (!storageTotalMB || storageTotalMB <= 0) {
      storageTotalMB = DEFAULT_FREE_QUOTA_MB;
      console.log(`[ACCOUNTS] fallback totalMB to FREE QUOTA: ${storageTotalMB}`);
    }
    // Evitar porcentajes > 100 si used > total
    if (storageUsedMB > storageTotalMB) {
      storageTotalMB = storageUsedMB;
    }

    console.log(`[ACCOUNTS] update metrics id=${id} used=${storageUsedMB}MB total=${storageTotalMB}MB`);
    const updated = await prisma.megaAccount.update({ where: { id }, data: { status: 'CONNECTED', statusMessage: null, lastCheckAt: new Date(), storageUsedMB, storageTotalMB } });

    console.log('[ACCOUNTS] testAccount OK');
    return res.json({ message: 'OK', status: 'CONNECTED', account: updated })
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
    const acc = await prisma.megaAccount.findUnique({ where: { id }, include: { credentials: true }})
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
        priority: acc.priority,
        status: acc.status,
        statusMessage: acc.statusMessage,
        storageUsedMB: acc.storageUsedMB,
        storageTotalMB: acc.storageTotalMB,
        lastCheckAt: acc.lastCheckAt,
      },
      items,
      itemsCount: items.length,
    })
  } catch (e) {
    console.error('Error getting account detail:', e)
    return res.status(500).json({ message: 'Error getting account detail' })
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
}

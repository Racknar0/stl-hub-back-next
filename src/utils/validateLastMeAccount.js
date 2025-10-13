import { PrismaClient } from '@prisma/client';
import { decryptToJson } from './cryptoUtils.js';
import { spawn } from 'child_process';
import { log } from './logger.js';
import { fileURLToPath } from 'url';
import path from 'path';

/*
  Script: validateLastMeAccount
  Objetivo:
    - Seleccionar la cuenta de MEGA de tipo MAIN con el lastCheckAt más antiguo (null primero) y refrescar sus métricas
    - Reproduce la lógica principal de testAccount (login -> métricas -> update -> logout)
    - Pensado para ejecutarse vía cron o manual: `node ./src/utils/validateLastMeAccount.js`
    - Se puede forzar una cuenta específica con env MEGA_ACCOUNT_ID

  Resultado:
    - Actualiza status, lastCheckAt, storageUsedMB, storageTotalMB, fileCount, folderCount
    - Devuelve un resumen en consola (JSON)

    Forzar una cuenta específica:
    $env:MEGA_ACCOUNT_ID=12; npm run validate:last
*/

const prisma = new PrismaClient();

const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480;

function runCmd(cmd, args = [], { cwd } = {}) {
  const maskArgs = (c, a) => (c && c.toLowerCase().includes('mega-login') ? ['<hidden>'] : a);
  const printable = `${cmd} ${(maskArgs(cmd, args) || []).join(' ')}`.trim();
  log.verbose(`Ejecutar: ${printable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => err += d.toString());
    child.on('close', (code) => {
      if (code === 0) {
        return resolve({ out, err });
      }
      reject(new Error(err || out || `${cmd} exited ${code}`));
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

export async function runValidateLastMeAccount() {
  const tStart = Date.now();
  const forcedId = process.env.MEGA_ACCOUNT_ID ? Number(process.env.MEGA_ACCOUNT_ID) : null;
  let account;
  try {
    if (forcedId) {
      account = await prisma.megaAccount.findUnique({ where: { id: forcedId }, include: { credentials: true } });
      if (!account) throw new Error(`Cuenta forzada id=${forcedId} no encontrada`);
      if (account.type !== 'main') throw new Error('La cuenta forzada no es de tipo MAIN');
      log.info(`[VALIDATE][SELECT] modo=forzado id=${account.id} alias=${account.alias} type=${account.type} suspended=${account.suspended} lastCheckAt=${account.lastCheckAt}`);
    } else {
      // Orden: cuentas MAIN con lastCheckAt null primero, luego más antiguo
      account = await prisma.megaAccount.findFirst({
        where: { suspended: false, type: 'main' },
        orderBy: [
          { lastCheckAt: 'asc' },
        ],
        include: { credentials: true },
      });
      if (account) {
        log.info(`[VALIDATE][SELECT] modo=auto id=${account.id} alias=${account.alias} type=${account.type} suspended=${account.suspended} lastCheckAt=${account.lastCheckAt}`);
      }
    }
    if (!account) {
  log.info('Validación: no hay cuentas disponibles');
      return { ok: true, skipped: true, reason: 'NO_ACCOUNTS' };
    }
    if (!account.credentials) throw new Error('La cuenta no posee credenciales almacenadas');

  log.info(`Validando cuenta id=${account.id} alias=${account.alias} lastCheckAt=${account.lastCheckAt}`);

    const payload = decryptToJson(account.credentials.encData, account.credentials.encIv, account.credentials.encTag);

    const loginCmd = 'mega-login';
    const logoutCmd = 'mega-logout';
    const mkdirCmd = 'mega-mkdir';
    const dfCmd = 'mega-df';
    const duCmd = 'mega-du';
    const findCmd = 'mega-find';

    // Limpiar sesión previa (ignorar errores)
    try { await runCmd(logoutCmd, []); } catch {}

    // Login
    try {
      if (payload?.type === 'session' && payload.session) {
        await runCmd(loginCmd, [payload.session]);
      } else if (payload?.username && payload?.password) {
        await runCmd(loginCmd, [payload.username, payload.password]);
      } else {
        throw new Error('Payload de credenciales inválido');
      }
      log.info(`[VALIDATE][LOGIN][OK] id=${account.id} alias=${account.alias}`);
    } catch (e) {
      const msg = String(e.message || '').toLowerCase();
      if (!msg.includes('already logged in')) throw e;
      log.warn(`[VALIDATE][LOGIN][SKIP] sesión ya activa para id=${account.id}`);
    }

    const base = (account.baseFolder || '/').trim();
    if (base && base !== '/') {
      try { await runCmd(mkdirCmd, ['-p', base]); log.verbose(`[VALIDATE][MKDIR] baseFolder=${base}`); } catch {}
    }

    let storageUsedMB = 0, storageTotalMB = 0, fileCount = 0, folderCount = 0;
    let storageSource = 'none';

    // Intentar mega-df -h
    try {
      const df = await runCmd(dfCmd, ['-h']);
      const txt = (df.out || df.err || '').toString();
      let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
        || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
        || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
        || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
        || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);
      if (m) {
        storageUsedMB = parseSizeToMB(m[1]);
        storageTotalMB = parseSizeToMB(m[2]);
        storageSource = 'df -h';
      }
      if (!storageTotalMB) {
        const p = txt.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)/i)
          || txt.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)/i);
        if (p) {
          storageTotalMB = parseSizeToMB(p[2]);
          const pct = parseFloat(String(p[1]).replace(',', '.'));
            if (!isNaN(pct) && isFinite(pct)) storageUsedMB = Math.round((pct / 100) * storageTotalMB);
            storageSource = storageSource === 'none' ? 'df -h (pct)' : storageSource;
        }
      }
    } catch (e) {
  log.warn('df -h advertencia: ' + String(e.message).slice(0,200));
    }

    if (!storageTotalMB) {
      try {
        const df = await runCmd(dfCmd, []);
        const txt = (df.out || df.err || '').toString();
        let m = txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i)
          || txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i)
          || txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i)
          || txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i)
          || txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);
        if (m) {
          storageUsedMB = parseSizeToMB(m[1]);
          storageTotalMB = parseSizeToMB(m[2]);
          storageSource = storageSource === 'none' ? 'df' : storageSource;
        }
      } catch (e) {
  log.warn('df advertencia: ' + String(e.message).slice(0,200));
      }
    }

    if (!storageUsedMB) {
      try {
        const du = await runCmd(duCmd, ['-h', base || '/']);
        const txt = (du.out || du.err || '').toString();
        const mm = txt.match(/[\r\n]*\s*([\d.,]+\s*[KMGT]?B)/i) || txt.match(/([\d.,]+\s*[KMGT]?B)/i);
        if (mm) { storageUsedMB = parseSizeToMB(mm[1]); storageSource = storageSource === 'none' ? 'du -h' : storageSource; }
      } catch (e) {
  log.warn('du -h advertencia: ' + String(e.message).slice(0,200));
      }
    }

    // Conteos con mega-find
    try {
      try {
        const f = await runCmd(findCmd, [base || '/', '--type=f']);
        fileCount = (f.out || '').split(/\r?\n/).filter(Boolean).length;
      } catch {
        const f = await runCmd(findCmd, ['--type=f', base || '/']);
        fileCount = (f.out || '').split(/\r?\n/).filter(Boolean).length;
      }
      try {
        const d = await runCmd(findCmd, [base || '/', '--type=d']);
        folderCount = (d.out || '').split(/\r?\n/).filter(Boolean).length;
      } catch {
        const d = await runCmd(findCmd, ['--type=d', base || '/']);
        folderCount = (d.out || '').split(/\r?\n/).filter(Boolean).length;
      }
    } catch (e) {
  log.warn('find advertencia: ' + String(e.message).slice(0,200));
    }

    if (!storageTotalMB || storageTotalMB <= 0) storageTotalMB = DEFAULT_FREE_QUOTA_MB;
    if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;

  log.info(`[VALIDATE][METRICS] account=${account.id} baseFolder="${base||'/'}" storageUsedMB=${storageUsedMB} storageTotalMB=${storageTotalMB} storageSource=${storageSource} fileCount=${fileCount} folderCount=${folderCount} countsSource=mega-find`);

    const tUpdate = Date.now();
    const updated = await prisma.megaAccount.update({
      where: { id: account.id },
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

  log.info(`[VALIDATE][UPDATE][OK] id=${updated.id} alias=${updated.alias} lastCheckAt=${updated.lastCheckAt}`);
  log.info('Validación OK ' + JSON.stringify({ id: updated.id, alias: updated.alias, storageUsedMB, storageTotalMB, fileCount, folderCount }));
    return { ok: true, accountId: updated.id, alias: updated.alias, storageUsedMB, storageTotalMB, fileCount, folderCount };
  } catch (e) {
  log.error('Error en validación: ' + e.message);
    if (account?.id) {
      try {
        await prisma.megaAccount.update({ where: { id: account.id }, data: { status: 'ERROR', statusMessage: String(e.message).slice(0,500), lastCheckAt: new Date() } });
      } catch {}
    }
    return { ok: false, error: String(e.message) };
  } finally {
    try { await runCmd('mega-logout', []); } catch {}
    try { await prisma.$disconnect(); } catch {}
    log.info(`[VALIDATE][END] elapsedMs=${Date.now()-tStart}`);
  }
}

// Ejecución directa CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runValidateLastMeAccount().then(r => {
  log.info('Resultado validación: ' + JSON.stringify(r));
    if (!r.ok) process.exitCode = 1;
  });
}

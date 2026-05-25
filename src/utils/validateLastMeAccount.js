import { PrismaClient } from '@prisma/client';
import { decryptToJson } from './cryptoUtils.js';
import { runCmd } from './megaCmd.js';
import { parseSizeToMB, parseStorageFromDfText } from './megaDfParser.js';
import { log } from './logger.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { withMegaLock } from './megaQueue.js';
import { applyMegaProxy, getStickyProxyForAccount } from './megaProxy.js';
import { loginWithSessionCache } from './megaSessionHelper.js';

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

async function ensureProxyOrThrow({ accountId, ctx, maxTries = 10 } = {}) {
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    const p = getStickyProxyForAccount({ id: accountId }, i);
    if (!p) {
      throw new Error(`[VALIDAR][PROXY] Sin proxies válidos (no se permite IP directa)${ctx ? ` ${ctx}` : ''}`);
    }
    try {
      const r = await applyMegaProxy(p, { ctx: ctx || 'validate:last', timeoutMs: 15000, clearOnFail: false });
      if (r?.enabled) {
        log.info(`[VALIDAR][PROXY][OK] ${p.proxyUrl}${ctx ? ` ${ctx}` : ''}`);
        return p;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`[VALIDAR][PROXY] Ningún proxy funcionó (no se permite IP directa). lastErr=${String(lastErr?.message || lastErr || '').slice(0, 160)}`);
}

// runCmd y parseSizeToMB ahora vienen de módulos centralizados (megaCmd.js, megaDfParser.js)

export async function runValidateLastMeAccount() {
  const tStart = Date.now();
  const forcedId = process.env.MEGA_ACCOUNT_ID ? Number(process.env.MEGA_ACCOUNT_ID) : null;
  let account;
  try {
    if (forcedId) {
      account = await prisma.megaAccount.findUnique({ where: { id: forcedId }, include: { credentials: true } });
      if (!account) throw new Error(`Cuenta forzada id=${forcedId} no encontrada`);
      if (account.type !== 'main') throw new Error('La cuenta forzada no es de tipo MAIN');
  log.info(`[VALIDAR][SELECCIÓN] modo=forzado id=${account.id} alias=${account.alias} tipo=${account.type} suspendida=${account.suspended} últimoChequeo=${account.lastCheckAt}`);
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
        log.info(`[VALIDAR][SELECCIÓN] modo=automático id=${account.id} alias=${account.alias} tipo=${account.type} suspendida=${account.suspended} últimoChequeo=${account.lastCheckAt}`);
      }
    }
    if (!account) {
  log.info('Validación: no hay cuentas MAIN disponibles');
      return { ok: true, skipped: true, reason: 'NO_ACCOUNTS' };
    }
    if (!account.credentials) throw new Error('La cuenta no posee credenciales almacenadas');

  log.info(`Validando cuenta MAIN id=${account.id} alias=${account.alias} últimoChequeo=${account.lastCheckAt}`);

    const payload = decryptToJson(account.credentials.encData, account.credentials.encIv, account.credentials.encTag);

    const loginCmd = 'mega-login';
    const logoutCmd = 'mega-logout';
    const mkdirCmd = 'mega-mkdir';
    const dfCmd = 'mega-df';
    const duCmd = 'mega-du';
    const findCmd = 'mega-find';

    const accCtx = `accId=${account.id} alias=${account.alias || '--'}`;

    const base = (account.baseFolder || '/').trim();
    let storageUsedMB = 0, storageTotalMB = 0, fileCount = 0, folderCount = 0;
    let storageSource = 'none';

    await withMegaLock(async () => {
      await ensureProxyOrThrow({ accountId: account.id, ctx: accCtx, maxTries: 10 });

      // Limpiar sesión previa (ignorar errores)
      try { await runCmd(logoutCmd, []); } catch {}

      // Login
      try {
        /* CÓDIGO ANTERIOR RESPALDADO
        if (payload?.type === 'session' && payload.session) {
          await runCmd(loginCmd, [payload.session]);
        } else if (payload?.username && payload?.password) {
          await runCmd(loginCmd, [payload.username, payload.password]);
        } else {
          throw new Error('Payload de credenciales inválido');
        }
        log.info(`[VALIDAR][LOGIN][OK] id=${account.id} alias=${account.alias}`);
        */
        const loginResult = await loginWithSessionCache(prisma, runCmd, account.id, payload, accCtx);
        log.info(`[VALIDAR][LOGIN][OK] id=${account.id} alias=${account.alias} metodo=${loginResult.method}`);
      } catch (e) {
        const msg = String(e.message || '').toLowerCase();
        if (!msg.includes('already logged in')) throw e;
        log.warn(`[VALIDAR][LOGIN][OMITIDO] sesión ya activa para id=${account.id}`);
      }

      if (base && base !== '/') {
        try { await runCmd(mkdirCmd, ['-p', base]); log.verbose(`[VALIDAR][MKDIR] carpetaBase=${base}`); } catch {}
      }

      // Intentar mega-df -h (usa parser centralizado con todos los regex EN/ES)
      try {
        const df = await runCmd(dfCmd, ['-h']);
        const txt = (df.out || df.err || '').toString();
        const parsed = parseStorageFromDfText(txt);
        storageUsedMB = parsed.storageUsedMB;
        storageTotalMB = parsed.storageTotalMB;
        if (storageTotalMB) storageSource = 'df -h';
      } catch (e) {
        log.warn('df -h advertencia: ' + String(e.message).slice(0,200));
      }

      if (!storageTotalMB) {
        try {
          const df = await runCmd(dfCmd, []);
          const txt = (df.out || df.err || '').toString();
          const parsed = parseStorageFromDfText(txt);
          storageUsedMB = parsed.storageUsedMB;
          storageTotalMB = parsed.storageTotalMB;
          if (storageTotalMB) storageSource = storageSource === 'none' ? 'df' : storageSource;
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

      // Logout best-effort al final del bloque MEGA
      try {
        /* CÓDIGO ANTERIOR RESPALDADO
        await runCmd(logoutCmd, []);
        */
        await runCmd(logoutCmd, ['--keep-session']);
      } catch {}
    }, 'VALIDATE-LAST-MEGA');

    if (!storageTotalMB || storageTotalMB <= 0) storageTotalMB = DEFAULT_FREE_QUOTA_MB;
    if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;

  log.info(`[VALIDAR][MÉTRICAS] cuenta=${account.id} carpetaBase="${base||'/'}" almacenamientoUsadoMB=${storageUsedMB} almacenamientoTotalMB=${storageTotalMB} fuenteAlmacenamiento=${storageSource} archivos=${fileCount} carpetas=${folderCount} fuenteConteos=mega-find`);

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

  log.info(`[VALIDAR][ACTUALIZADO] id=${updated.id} alias=${updated.alias} últimoChequeo=${updated.lastCheckAt}`);
  log.info(`Validación OK -> Cuenta MAIN ${updated.alias} (id ${updated.id}). Almacenamiento: ${storageUsedMB}/${storageTotalMB} MB. Archivos: ${fileCount}. Carpetas: ${folderCount}.`);
    return { ok: true, accountId: updated.id, alias: updated.alias, storageUsedMB, storageTotalMB, fileCount, folderCount };
  } catch (e) {
  log.error('Error en validación: ' + e.message);
    if (account?.id) {
      try {
        await prisma.megaAccount.update({ where: { id: account.id }, data: { status: 'ERROR', statusMessage: String(e.message).slice(0,500), lastCheckAt: new Date() } });
      } catch {}
      // Crear notificación en la base de datos
      try {
        const notifTitle = `Fallo en validación de cuenta MAIN (Validador)`;
        const notifBody = `La cuenta MAIN ${account.alias || '--'} (ID=${account.id}, Email=${account.email || '--'}) falló al validarse. Detalle del error: ${e.message}`;
        await prisma.notification.create({
          data: {
            title: notifTitle,
            body: notifBody.slice(0, 1000),
            status: 'UNREAD',
            type: 'AUTOMATION',
            typeStatus: 'ERROR'
          }
        });
      } catch (notifErr) {
        log.warn('No se pudo crear notificación para fallo de validación: ' + notifErr.message);
      }
    }
    return { ok: false, error: String(e.message) };
  } finally {
    // Evitar mega-logout si no podemos asegurar proxy (no se permite IP directa)
    try {
      await withMegaLock(async () => {
        try {
          await ensureProxyOrThrow({ accountId: account?.id, ctx: 'validate:last cleanup', maxTries: 3 });
          /* CÓDIGO ANTERIOR RESPALDADO
          await runCmd('mega-logout', []);
          */
          await runCmd('mega-logout', ['--keep-session']);
        } catch {
          // skip cleanup
        }
      }, 'VALIDATE-LAST-CLEANUP');
    } catch {}
    try { await prisma.$disconnect(); } catch {}
  log.info(`[VALIDAR][FIN] duracionMs=${Date.now()-tStart}`);
  }
}

// Ejecución directa CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runValidateLastMeAccount().then(r => {
  log.info('Resultado validación: ' + JSON.stringify(r));
    if (!r.ok) process.exitCode = 1;
  });
}

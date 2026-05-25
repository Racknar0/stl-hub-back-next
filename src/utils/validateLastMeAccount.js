import { PrismaClient } from '@prisma/client';
import { decryptToJson } from './cryptoUtils.js';
import { runCmd } from './megaCmd.js';
import { parseSizeToMB, parseStorageFromDfText } from './megaDfParser.js';
import { log } from './logger.js';
import { fileURLToPath } from 'url';
import path from 'path';
import { withMegaLock } from './megaQueue.js';
import { megaLoginFull, megaLogoutSafe } from './megaSession.js';

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

// ensureProxyOrThrow ya no es necesario: megaLoginFull maneja proxy + rotación internamente

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
      // megaLoginFull maneja: proxy, logout preventivo, session cache, retry, reset servidor
      await megaLoginFull(prisma, account.id, payload, accCtx, {
        skipStorageRefresh: true,  // este script hace su propia recolección de métricas
        maxProxyRetries: 10,
      });
      log.info(`[VALIDAR][LOGIN][OK] id=${account.id} alias=${account.alias}`);

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
      await megaLogoutSafe('validate:last cleanup');
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

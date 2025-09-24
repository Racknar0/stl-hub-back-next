import { PrismaClient } from '@prisma/client';
import { decryptToJson } from './cryptoUtils.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

/*
  Script: validateAssetsOnLastAccount
  Objetivo:
    - Tomar la cuenta de MEGA "última verificada" (mayor lastCheckAt, status CONNECTED y no suspendida)
      o una forzada vía env MEGA_ACCOUNT_ID.
    - Para cada asset PUBLISHED asociado a esa cuenta (accountId), verificar que el archivo remoto
      realmente existe en MEGA (dentro de baseFolder/slug/ARCHIVO).
    - Se mantiene UNA sola sesión abierta (login al inicio, logout al final) para minimizar riesgo de castigo.
    - Entre cada verificación se aplica un delay parametrizable (VALIDATION_DELAY_MS, por defecto 1500ms).

  Uso:
    node ./src/utils/validateAssetsOnLastAccount.js
    $env:VALIDATION_DELAY_MS=3000; node ./src/utils/validateAssetsOnLastAccount.js
    $env:MEGA_ACCOUNT_ID=7; node ./src/utils/validateAssetsOnLastAccount.js

  Salida:
    - Logs por asset: [ASSET-CHECK] id=.. slug=.. exists=TRUE|FALSE remotePath=...
    - Resumen JSON final: totals, missingIds, firstMissingSamples
*/

const prisma = new PrismaClient();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function runCmd(cmd, args = [], { mask = false } = {}) {
  const displayArgs = mask ? ['<hidden>'] : args;
  console.log(`[MEGA] > ${cmd} ${displayArgs.join(' ')}`.trim());
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(err || out || `${cmd} exited ${code}`));
    });
  });
}

export async function runValidateAssetsOnLastAccount() {
  const SCRIPT_VERSION = 'v3-debug1';
  const forcedId = process.env.MEGA_ACCOUNT_ID ? Number(process.env.MEGA_ACCOUNT_ID) : null;
  const delayMs = Number(process.env.VALIDATION_DELAY_MS) > 0 ? Number(process.env.VALIDATION_DELAY_MS) : 1500;
  let account;
  try {
    console.log(`[ASSET-VALIDATE] Script version=${SCRIPT_VERSION} DEBUG_VALIDATE=${process.env.DEBUG_VALIDATE || '0'} forcedId=${forcedId || 'none'}`);
    try {
      const publishedCountsAll = await prisma.asset.groupBy({
        by: ['accountId'],
        where: { status: 'PUBLISHED' },
        _count: { accountId: true },
      });
      console.log('[ASSET-VALIDATE] Published assets por cuenta (incluye archiveName null):', publishedCountsAll.map(c=>`${c.accountId}=${c._count.accountId}`).join(', '));
      const publishedWithArchive = await prisma.asset.groupBy({
        by: ['accountId'],
        where: { status: 'PUBLISHED', archiveName: { not: null } },
        _count: { accountId: true },
      });
      console.log('[ASSET-VALIDATE] Published assets con archiveName no null:', publishedWithArchive.map(c=>`${c.accountId}=${c._count.accountId}`).join(', '));
    } catch (dbgErr) {
      console.log('[ASSET-VALIDATE][DEBUG] Error obteniendo conteos iniciales:', dbgErr.message);
    }
    if (forcedId) {
      account = await prisma.megaAccount.findUnique({ where: { id: forcedId }, include: { credentials: true } });
      if (!account) throw new Error(`Cuenta forzada id=${forcedId} no encontrada`);
      const forcedPublished = await prisma.asset.count({ where: { accountId: forcedId, status: 'PUBLISHED', archiveName: { not: null } } });
      if (forcedPublished === 0) {
        console.warn(`[ASSET-VALIDATE] Cuenta forzada id=${forcedId} no tiene assets PUBLISHED con archiveName; usando modo auto.`);
        account = null; // dispara selección automática abajo
      }
    }
    if (!account) {
      // Estrategia revisada:
      // 1) Obtener IDs distintos de cuentas que poseen assets PUBLISHED (más confiable que groupBy en algunos entornos)
      // 2) Traer esas cuentas (no suspendidas) + _count.assetsPublished
      // 3) Ordenar: lastCheckAt NULL primero, luego el más antiguo
      const publishedAccountRows = await prisma.asset.findMany({
        where: { status: 'PUBLISHED', archiveName: { not: null } },
        select: { accountId: true },
        distinct: ['accountId'],
      });
      const publishedAccountIds = Array.from(new Set(publishedAccountRows.map(r => r.accountId)));
      if (process.env.DEBUG_VALIDATE) {
        console.log('[ASSET-VALIDATE][DEBUG] publishedAccountIds:', publishedAccountIds);
      }
      if (publishedAccountIds.length) {
        const candidatesRaw = await prisma.megaAccount.findMany({
          where: { id: { in: publishedAccountIds }, suspended: false, status: 'CONNECTED' },
          include: { credentials: true, _count: { select: { assets: true } } },
        });
        // Calcular published count manual (más preciso):
        const publishedCounts = await prisma.asset.groupBy({
          by: ['accountId'],
          where: { status: 'PUBLISHED', archiveName: { not: null }, accountId: { in: publishedAccountIds } },
          _count: { accountId: true },
        });
        const publishedMap = new Map(publishedCounts.map(c => [c.accountId, c._count.accountId]));
        const candidates = candidatesRaw.map(c => ({
          ...c,
          _published: publishedMap.get(c.id) || 0,
        })).filter(c => c._published > 0);
        if (process.env.DEBUG_VALIDATE) {
          console.log('[ASSET-VALIDATE][DEBUG] published counts map:', Array.from(publishedMap.entries()));
        }
        candidates.sort((a,b)=>{
          const an = a.lastCheckAt == null; const bn = b.lastCheckAt == null;
          if (an && !bn) return -1;
          if (!an && bn) return 1;
          const at = a.lastCheckAt ? a.lastCheckAt.getTime() : 0;
          const bt = b.lastCheckAt ? b.lastCheckAt.getTime() : 0;
          // Si fechas iguales, el que tenga MÁS assets publicados primero (para rotar más rápido cuentas grandes)
          if (at === bt) return b._published - a._published;
          return at - bt;
        });
        console.log('[ASSET-VALIDATE] Candidatas:', candidates.map(c=>`${c.id}:${c.lastCheckAt || 'NULL'}#pub=${c._published}`).join(', '));
        account = candidates[0] || null;
        // Fallback: si por algún motivo la seleccionada NO tiene assets publicados reales, intentar la siguiente
        if (account) {
          const publishedForAccount = await prisma.asset.count({ where: { status: 'PUBLISHED', accountId: account.id } });
          if (!publishedForAccount) {
            const alt = candidates.find(c => c.id !== account.id && c._published > 0);
            if (alt) account = alt;
          }
        }
      } else {
        account = null;
      }
    }
    if (!account) {
      console.log('[ASSET-VALIDATE] No hay cuenta conectada para validar');
      return { ok: true, skipped: true, reason: 'NO_ACCOUNT' };
    }
    if (!account.credentials) throw new Error('Cuenta sin credenciales');

    console.log(`[ASSET-VALIDATE] Cuenta objetivo id=${account.id} alias=${account.alias} baseFolder=${account.baseFolder || '/'} delayMs=${delayMs}`);

    const payload = decryptToJson(account.credentials.encData, account.credentials.encIv, account.credentials.encTag);
    const loginCmd = 'mega-login';
    const logoutCmd = 'mega-logout';
    const findCmd = 'mega-find';

    // Limpiar sesión previa (ignorar error)
    try { await runCmd(logoutCmd, []); } catch {}

    // Login
    if (payload?.type === 'session' && payload.session) {
      await runCmd(loginCmd, [payload.session], { mask: true });
    } else if (payload?.username && payload?.password) {
      await runCmd(loginCmd, [payload.username, payload.password], { mask: true });
    } else {
      throw new Error('Payload de credenciales inválido');
    }

    const remoteBase = (account.baseFolder || '/').replace(/\\/g, '/');

    // Obtener assets publicados de esa cuenta
    const assets = await prisma.asset.findMany({
      where: { accountId: account.id, status: 'PUBLISHED', archiveName: { not: null } },
      select: { id: true, slug: true, archiveName: true },
      orderBy: { id: 'asc' },
    });

    console.log(`[ASSET-VALIDATE] Total assets publicados a revisar: ${assets.length}`);
    const results = [];
    for (const a of assets) {
      const baseFile = path.basename(String(a.archiveName));
      const remoteDir = path.posix.join(remoteBase, a.slug);
      const remoteFile = path.posix.join(remoteDir, baseFile);
      let exists = false;
      try {
        // Estrategia: listar archivos en el directorio del slug y buscar coincidencia exacta del nombre
        // mega-find <path> --type=f puede no aceptar path completo en algunas versiones -> fallback simple
        let listing;
        try {
          listing = await runCmd(findCmd, [remoteDir, '--type=f']);
        } catch (e) {
          // fallback intentando sin --type=f (listará todo)
          listing = await runCmd(findCmd, [remoteDir]);
        }
        const lines = (listing.out || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        exists = lines.some(l => l.endsWith(`/${baseFile}`) || l === baseFile || l.toLowerCase().endsWith(`/${baseFile.toLowerCase()}`));
      } catch (e) {
        console.warn(`[ASSET-CHECK] WARN id=${a.id} slug=${a.slug} error=${String(e.message).slice(0,120)}`);
      }
      console.log(`[ASSET-CHECK] id=${a.id} slug=${a.slug} exists=${exists ? 'TRUE' : 'FALSE'} remote=${remoteFile}`);
      results.push({ id: a.id, slug: a.slug, exists, remoteFile });
      if (delayMs) await sleep(delayMs);
    }

    const missing = results.filter(r => !r.exists).map(r => r.id);

    // Actualizar lastCheckAt y status (mantener CONNECTED) igual que el otro script de validación de cuentas
    try {
      await prisma.megaAccount.update({
        where: { id: account.id },
        data: { lastCheckAt: new Date(), status: 'CONNECTED', statusMessage: null },
      });
    } catch (e) {
      console.warn('[ASSET-VALIDATE] No se pudo actualizar lastCheckAt:', e.message);
    }

    const summary = {
      ok: true,
      accountId: account.id,
      alias: account.alias,
      checked: results.length,
      missingCount: missing.length,
      missingIds: missing.slice(0, 50),
      updatedLastCheckAt: true,
    };
    console.log('[ASSET-VALIDATE] RESUMEN', JSON.stringify(summary, null, 2));
    return summary;
  } catch (e) {
    console.error('[ASSET-VALIDATE] ERROR', e.message);
    // Si hubo error global, actualizar estado de la cuenta
    try {
      if (account?.id) {
        await prisma.megaAccount.update({
          where: { id: account.id },
          data: { status: 'ERROR', statusMessage: String(e.message).slice(0,500), lastCheckAt: new Date() },
        });
      }
    } catch (uErr) {
      console.warn('[ASSET-VALIDATE] No se pudo marcar ERROR en la cuenta:', uErr.message);
    }
    return { ok: false, error: e.message };
  } finally {
    try { await runCmd('mega-logout', []); } catch {}
    try { await prisma.$disconnect(); } catch {}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runValidateAssetsOnLastAccount().then(r => {
    if (!r.ok) process.exitCode = 1;
  });
}

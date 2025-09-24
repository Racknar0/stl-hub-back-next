import { PrismaClient } from '@prisma/client';
import { decryptToJson } from './cryptoUtils.js';
import { withMegaLock } from './megaQueue.js';
import { spawn } from 'child_process';
import path from 'path';

const prisma = new PrismaClient();

// =============== CONFIGURAR AQUÍ ===============
// DEFAULT_ACCOUNT_ID: id por defecto si no pasas argumento al ejecutar.
// DRY_RUN: por defecto true (solo muestra). Para aplicar realmente poner variable de entorno RENAME_DRY_RUN=false.
/*
USO:

SIMULACIÓN (no renombra, solo muestra) - es el modo por defecto:
  PowerShell:
    node masiveRename.js 16
  CMD:
    node masiveRename.js 16

FORZAR SIMULACIÓN EXPLÍCITA:
  PowerShell:
    $env:RENAME_DRY_RUN="true"; node masiveRename.js 16
  CMD:
    set RENAME_DRY_RUN=true && node masiveRename.js 16

MODO REAL (aplica renombres):
  PowerShell:
    $env:RENAME_DRY_RUN="false"; node masiveRename.js 16
  CMD:
    set RENAME_DRY_RUN=false && node masiveRename.js 16

SIN ARGUMENTO (usa DEFAULT_ACCOUNT_ID):
  node masiveRename.js

Cambiar DEFAULT_ACCOUNT_ID en el código o pasar el id como argumento.
*/
const DEFAULT_ACCOUNT_ID = 16; // <--- CAMBIA ESTE NÚMERO AL ID DE LA CUENTA
const DRY_RUN = process.env.RENAME_DRY_RUN
  ? /^(false|0|no)$/i.test(process.env.RENAME_DRY_RUN) ? false : true
  : true; // true = solo muestra, false = aplica
// ===============================================

const ACCOUNT_ID = process.argv[2] ? Number(process.argv[2]) : DEFAULT_ACCOUNT_ID;

function runCmd(cmd, args = [], { print = true } = {}) {
  if (print) console.log(`[CMD] > ${cmd} ${(args||[]).join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(err || out || `${cmd} exit ${code}`));
    });
  });
}

async function megaLogin(payload) {
  if (payload?.type === 'session' && payload.session) {
    await runCmd('mega-login', [payload.session]);
  } else if (payload?.username && payload?.password) {
    await runCmd('mega-login', [payload.username, payload.password]);
  } else {
    throw new Error('Credenciales inválidas');
  }
}

async function megaLogout() { try { await runCmd('mega-logout', []); } catch {} }

function calcNuevoNombre(fileName) {
  const i = fileName.indexOf('__');
  if (i <= 0) return null;
  const nuevo = fileName.slice(i + 2);
  return nuevo || null;
}

export async function massiveRename(accountId = ACCOUNT_ID) {
  console.log(`=== MASSIVE RENAME cuenta=${accountId} DRY_RUN=${DRY_RUN} ===`);
  if (!accountId) throw new Error('ID de cuenta inválido');

  const acc = await prisma.megaAccount.findUnique({
    where: { id: accountId },
    include: { credentials: true }
  });
  if (!acc) throw new Error('Cuenta no encontrada');
  if (!acc.credentials) throw new Error('Sin credenciales');

  const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag);
  const baseFolder = (acc.baseFolder || '/').replaceAll('\\', '/');
  console.log(`[INFO] baseFolder=${baseFolder}`);

  const stats = {
    total: 0,
    conPatron: 0,
    renombrados: 0,
    saltadosExiste: 0,
    sinPatron: 0,
    errores: 0
  };

  await withMegaLock(async () => {
    await megaLogout();
    await megaLogin(payload);

    let listado;
    try {
      const r = await runCmd('mega-find', [baseFolder, '--type=f']);
      listado = (r.out || '').split(/\r?\n/).filter(Boolean);
    } catch {
      const r2 = await runCmd('mega-find', ['--type=f', baseFolder]);
      listado = (r2.out || '').split(/\r?\n/).filter(Boolean);
    }

    stats.total = listado.length;
    console.log(`[INFO] archivosDetectados=${stats.total}`);

    for (const raw of listado) {
      const remotePath = raw.trim();
      if (!remotePath) continue;
      const nombre = path.posix.basename(remotePath);
      const dir = path.posix.dirname(remotePath);
      const nuevoNombre = calcNuevoNombre(nombre);
      if (!nuevoNombre) { stats.sinPatron++; continue; }
      stats.conPatron++;

      const destino = dir === '/' ? `/${nuevoNombre}` : `${dir}/${nuevoNombre}`;
      if (destino === remotePath) { stats.saltadosExiste++; continue; }

      let existeDestino = false;
      try {
        const ls = await runCmd('mega-ls', [destino], { print: false });
        if ((ls.out || ls.err || '').toLowerCase().includes(nuevoNombre.toLowerCase())) existeDestino = true;
      } catch { /* no existe */ }

      if (existeDestino) {
        console.log(`[SKIP] ya existe -> ${destino}`);
        stats.saltadosExiste++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`[DRY] ${remotePath} -> ${destino}`);
        continue;
      }

      try {
        await runCmd('mega-mv', [remotePath, destino]);
        console.log(`[OK] ${remotePath} -> ${destino}`);
        stats.renombrados++;
      } catch (e) {
        console.warn(`[ERR] ${remotePath} -> ${destino} : ${e.message}`);
        stats.errores++;
      }
    }

    await megaLogout();
  }, `RENAME-${accountId}`);

  console.log('=== RESUMEN ===');
  console.log(stats);
  if (DRY_RUN) console.log('Modo simulación (DRY_RUN). Para aplicar: PowerShell -> $env:RENAME_DRY_RUN="false"; node masiveRename.js 16 | CMD -> set RENAME_DRY_RUN=false && node masiveRename.js 16');
  return stats;
}

// Ejecución directa
if (process.argv[1] && process.argv[1].toLowerCase().includes('masiverenam'.toLowerCase())) {
  massiveRename().then(() => {
    console.log('Fin');
    process.exit(0);
  }).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

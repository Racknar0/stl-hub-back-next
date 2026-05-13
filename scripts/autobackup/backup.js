#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
//  STL Hub — Automated Full Backup
// ════════════════════════════════════════════════════════════════
//  Runs daily via cron. Each execution backs up EVERYTHING:
//    1. MySQL        → mysqldump + gzip
//    2. Qdrant       → snapshot API (stls-multimodal)
//    3. .env         → copy
//    4. Images       → tar.gz of uploads/images/
//
//  Then uploads to Google Drive via rclone.
//  Maintains: 1 local copy (latest) + 2 Drive copies.
//
//  Usage:
//    node --env-file=.env scripts/autobackup/backup.js
//
//  Cron (VPS):
//    0 9 * * * cd /var/www/backend && node --env-file=.env scripts/autobackup/backup.js >> /var/log/stlhub-backup.log 2>&1
// ════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..'); // → backend/

const prisma = new PrismaClient();

// ── Config ─────────────────────────────────────────────────────
const BACKUP_DIR      = process.env.BACKUP_DIR           || path.join(ROOT, '.backups');
const RCLONE_REMOTE   = process.env.BACKUP_RCLONE_REMOTE || 'gdrive';
const RCLONE_PATH     = process.env.BACKUP_RCLONE_PATH   || 'stlhub-backups';
const DRIVE_RETENTION = Math.max(1, parseInt(process.env.BACKUP_DRIVE_RETENTION || '2', 10));

const QDRANT_HOST       = process.env.QDRANT_HOST || '127.0.0.1';
const QDRANT_PORT       = process.env.QDRANT_PORT || '6333';
const QDRANT_COLLECTION = process.env.QDRANT_MULTIMODAL_COLLECTION || 'stls-multimodal';

const UPLOADS_DIR = path.join(ROOT, 'uploads');
const ENV_FILE    = path.join(ROOT, '.env');

// ── State ──────────────────────────────────────────────────────
const NOW       = new Date();
const DATE_TAG  = NOW.toISOString().slice(0, 10);                     // 2026-05-13
const TIME_TAG  = NOW.toISOString().slice(11, 16).replace(':', '');   // 0400
const results   = [];
const startTime = Date.now();

// ── Helpers ────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseDatabaseUrl(url) {
  // mysql://user:pass@host:port/dbname → parsed via URL class
  const parsed = new URL(url.replace(/^mysql:\/\//, 'http://'));
  return {
    user:     decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host:     parsed.hostname,
    port:     parsed.port || '3306',
    database: parsed.pathname.slice(1), // remove leading /
  };
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── Preflight checks ──────────────────────────────────────────
function preflight() {
  log('🔍 Verificando requisitos...');

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está definida en .env');
  }

  if (!commandExists('mysqldump')) {
    throw new Error('mysqldump no está instalado. Instala con: apt install mysql-client');
  }

  if (!commandExists('rclone')) {
    throw new Error('rclone no está instalado. Instala con: curl https://rclone.org/install.sh | sudo bash');
  }

  if (!commandExists('tar')) {
    throw new Error('tar no está instalado');
  }

  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`.env no encontrado en ${ENV_FILE}`);
  }

  // Verify rclone remote is configured
  try {
    execSync(`rclone listremotes`, { stdio: 'pipe', encoding: 'utf8' });
  } catch {
    throw new Error('rclone no tiene remotes configurados. Ejecuta: rclone config');
  }

  log('✅ Requisitos OK');
}

// ── Step 1: MySQL ─────────────────────────────────────────────
async function backupMySQL(destDir) {
  log('📦 MySQL: iniciando dump...');
  const db = parseDatabaseUrl(process.env.DATABASE_URL);
  const outFile = path.join(destDir, `mysql_${db.database}_${DATE_TAG}_${TIME_TAG}.sql.gz`);

  // Use MYSQL_PWD env var (avoids password visible in ps)
  const cmd = `mysqldump --single-transaction --routines --triggers -u ${db.user} -h ${db.host} -P ${db.port} ${db.database} | gzip > "${outFile}"`;

  execSync(cmd, {
    stdio: 'pipe',
    shell: '/bin/bash',
    env: { ...process.env, MYSQL_PWD: db.password },
    timeout: 10 * 60 * 1000, // 10 min
  });

  const size = fs.statSync(outFile).size;
  log(`📦 MySQL: OK (${formatBytes(size)})`);
  results.push({ step: 'MySQL', status: 'OK', size: formatBytes(size) });
}

// ── Step 2: Qdrant ────────────────────────────────────────────
async function backupQdrant(destDir) {
  log('🧠 Qdrant: creando snapshot...');
  const baseUrl = `http://${QDRANT_HOST}:${QDRANT_PORT}`;

  // 1. Create snapshot
  const createRes = await fetch(
    `${baseUrl}/collections/${QDRANT_COLLECTION}/snapshots`,
    { method: 'POST' }
  );

  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Snapshot create failed (${createRes.status}): ${body}`);
  }

  const createData = await createRes.json();
  const snapshotName = createData?.result?.name;
  if (!snapshotName) throw new Error('Qdrant no devolvió nombre de snapshot');

  log(`🧠 Qdrant: snapshot "${snapshotName}" creado, descargando...`);

  // 2. Download snapshot (streaming para archivos grandes)
  const outFile = path.join(destDir, `qdrant_${QDRANT_COLLECTION}_${DATE_TAG}.snapshot`);
  const dlRes = await fetch(
    `${baseUrl}/collections/${QDRANT_COLLECTION}/snapshots/${snapshotName}`
  );
  if (!dlRes.ok) throw new Error(`Snapshot download failed (${dlRes.status})`);

  const readableStream = Readable.fromWeb(dlRes.body);
  const fileStream = fs.createWriteStream(outFile);
  await pipeline(readableStream, fileStream);

  const size = fs.statSync(outFile).size;
  log(`🧠 Qdrant: OK (${formatBytes(size)})`);

  // 3. Cleanup: remove snapshot from Qdrant server storage
  try {
    await fetch(
      `${baseUrl}/collections/${QDRANT_COLLECTION}/snapshots/${snapshotName}`,
      { method: 'DELETE' }
    );
    log('🧠 Qdrant: snapshot temporal eliminado del servidor');
  } catch (e) {
    log(`⚠️  Qdrant: no se pudo eliminar snapshot temporal: ${e.message}`);
  }

  results.push({ step: 'Qdrant', status: 'OK', size: formatBytes(size) });
}

// ── Step 3: .env ──────────────────────────────────────────────
async function backupEnv(destDir) {
  log('🔐 .env: copiando...');
  const outFile = path.join(destDir, `env_${DATE_TAG}`);
  fs.copyFileSync(ENV_FILE, outFile);
  const size = fs.statSync(outFile).size;
  log(`🔐 .env: OK (${formatBytes(size)})`);
  results.push({ step: '.env', status: 'OK', size: formatBytes(size) });
}

// ── Step 4: Images ────────────────────────────────────────────
async function backupImages(destDir) {
  log('🖼️  Imágenes: comprimiendo...');
  const imagesDir = path.join(UPLOADS_DIR, 'images');

  if (!fs.existsSync(imagesDir)) {
    log('⚠️  Imágenes: directorio uploads/images/ no existe, saltando');
    results.push({ step: 'Imágenes', status: 'SKIP', size: '-' });
    return;
  }

  const outFile = path.join(destDir, `images_${DATE_TAG}.tar.gz`);
  const cmd = `tar czf "${outFile}" -C "${UPLOADS_DIR}" images/`;

  execSync(cmd, {
    stdio: 'pipe',
    timeout: 60 * 60 * 1000, // 1 hour (images can be huge)
  });

  const size = fs.statSync(outFile).size;
  log(`🖼️  Imágenes: OK (${formatBytes(size)})`);
  results.push({ step: 'Imágenes', status: 'OK', size: formatBytes(size) });
}

// ── Step 5: Upload to Google Drive ────────────────────────────
async function uploadToDrive(localDir) {
  log('☁️  Drive: subiendo...');
  const remotePath = `${RCLONE_REMOTE}:${RCLONE_PATH}/${path.basename(localDir)}/`;

  execSync(`rclone copy "${localDir}" "${remotePath}"`, {
    stdio: 'inherit',
    timeout: 2 * 60 * 60 * 1000, // 2 hours (images can be large)
  });

  log(`☁️  Drive: subido a ${remotePath}`);
  results.push({ step: 'Drive', status: 'OK', size: '-' });
}

// ── Step 6: Rotate Drive (keep N) ─────────────────────────────
async function rotateDrive() {
  log(`🔄 Drive: rotando (mantener ${DRIVE_RETENTION})...`);
  const remotePath = `${RCLONE_REMOTE}:${RCLONE_PATH}/`;

  let dirs;
  try {
    const output = execSync(`rclone lsf "${remotePath}" --dirs-only`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    dirs = output.trim().split('\n').filter(Boolean).map(d => d.replace(/\/$/, '')).sort();
  } catch {
    log('⚠️  Drive: no se pudieron listar carpetas');
    return;
  }

  if (dirs.length <= DRIVE_RETENTION) {
    log(`🔄 Drive: ${dirs.length} carpeta(s), no hay que borrar`);
    return;
  }

  const toDelete = dirs.slice(0, dirs.length - DRIVE_RETENTION);
  for (const dir of toDelete) {
    log(`🗑️  Drive: borrando ${dir}/`);
    execSync(`rclone purge "${remotePath}${dir}/"`, { stdio: 'pipe' });
  }

  log(`🔄 Drive: rotación OK (eliminadas ${toDelete.length} carpeta(s))`);
}

// ── Step 7: Rotate Local (keep only current) ──────────────────
async function rotateLocal(currentDir) {
  log('🔄 Local: limpiando backups anteriores...');

  if (!fs.existsSync(BACKUP_DIR)) return;

  const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== path.basename(currentDir))
    .map(e => e.name);

  for (const dir of entries) {
    const fullPath = path.join(BACKUP_DIR, dir);
    fs.rmSync(fullPath, { recursive: true, force: true });
    log(`🗑️  Local: eliminado ${dir}/`);
  }

  if (entries.length === 0) {
    log('🔄 Local: nada que limpiar');
  }
}

// ── Step 8: Dashboard Notification ────────────────────────────
async function sendNotification(success, errorMsg = null) {
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  const lines = results.map(r =>
    `• ${r.step}: ${r.status}${r.size !== '-' ? ` (${r.size})` : ''}`
  );

  const title = success ? '✅ Backup FULL completado' : '❌ Backup FULL falló';
  const body = [
    `Fecha: ${DATE_TAG}`,
    `Tiempo total: ${elapsed} min`,
    '',
    ...lines,
    ...(errorMsg ? ['', `Errores:`, errorMsg] : []),
  ].join('\n');

  try {
    await prisma.notification.create({
      data: {
        title,
        body,
        type: 'AUTOMATION',
        typeStatus: success ? 'SUCCESS' : 'ERROR',
      },
    });
    log(`📢 Notificación enviada: ${title}`);
  } catch (e) {
    log(`⚠️  Error creando notificación: ${e.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  log('═══════════════════════════════════════════');
  log('  STL Hub — Backup FULL diario');
  log(`  ${DATE_TAG} ${TIME_TAG}`);
  log('═══════════════════════════════════════════');

  // Preflight
  preflight();

  // Create today's backup directory
  const dayDir = path.join(BACKUP_DIR, DATE_TAG);
  fs.mkdirSync(dayDir, { recursive: true, mode: 0o700 });

  let hasError = false;
  let errorMsg = '';

  // 1. MySQL
  try {
    await backupMySQL(dayDir);
  } catch (e) {
    log(`❌ MySQL FALLÓ: ${e.message}`);
    results.push({ step: 'MySQL', status: 'ERROR', size: '-' });
    hasError = true;
    errorMsg += `MySQL: ${e.message}\n`;
  }

  // 2. Qdrant
  try {
    await backupQdrant(dayDir);
  } catch (e) {
    log(`❌ Qdrant FALLÓ: ${e.message}`);
    results.push({ step: 'Qdrant', status: 'ERROR', size: '-' });
    hasError = true;
    errorMsg += `Qdrant: ${e.message}\n`;
  }

  // 3. .env
  try {
    await backupEnv(dayDir);
  } catch (e) {
    log(`❌ .env FALLÓ: ${e.message}`);
    results.push({ step: '.env', status: 'ERROR', size: '-' });
    hasError = true;
    errorMsg += `.env: ${e.message}\n`;
  }

  // 4. Images
  try {
    await backupImages(dayDir);
  } catch (e) {
    log(`❌ Imágenes FALLÓ: ${e.message}`);
    results.push({ step: 'Imágenes', status: 'ERROR', size: '-' });
    hasError = true;
    errorMsg += `Imágenes: ${e.message}\n`;
  }

  // 5. Upload to Drive
  try {
    await uploadToDrive(dayDir);
  } catch (e) {
    log(`❌ Drive FALLÓ: ${e.message}`);
    results.push({ step: 'Drive', status: 'ERROR', size: '-' });
    hasError = true;
    errorMsg += `Drive: ${e.message}\n`;
  }

  // 6. Rotate Drive
  try {
    await rotateDrive();
  } catch (e) {
    log(`⚠️  Rotación Drive falló: ${e.message}`);
  }

  // 7. Rotate Local
  try {
    await rotateLocal(dayDir);
  } catch (e) {
    log(`⚠️  Rotación local falló: ${e.message}`);
  }

  // 8. Notify dashboard
  await sendNotification(!hasError, hasError ? errorMsg : null);

  await prisma.$disconnect();

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log('═══════════════════════════════════════════');
  log(`  ${hasError ? '⚠️  Completado con errores' : '✅ Completado exitosamente'} (${elapsed} min)`);
  log('═══════════════════════════════════════════');

  process.exit(hasError ? 1 : 0);
}

main().catch(async (err) => {
  console.error('💀 Error fatal:', err);
  try {
    await sendNotification(false, err.message);
  } catch { /* ignore */ }
  await prisma.$disconnect();
  process.exit(1);
});

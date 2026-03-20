import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { requestBatchProxySwitch } from '../utils/batchProxySwitch.js';

const prisma = new PrismaClient();
const UPLOADS_DIR = path.resolve('uploads');
const BATCH_DIR = path.join(UPLOADS_DIR, 'batch_imports');
const ARCHIVE_EXTS = ['.rar', '.zip', '.7z', '.tar', '.gz', '.tgz'];
const TITLE_PREFIX_RE = /^\s*STL\s*-\s*/i;
const MAX_ACCOUNT_UPLOAD_MB = Number(process.env.BATCH_ACCOUNT_MAX_MB) || (19 * 1024);

function normalizeBaseTitle(raw, fallback = 'Asset') {
  const cleaned = String(raw || '').replace(TITLE_PREFIX_RE, '').trim();
  return cleaned || fallback;
}

function normalizeTitleKey(raw) {
  return normalizeBaseTitle(raw, '').toLowerCase();
}

function buildAssetTitle(baseTitle) {
  return `STL - ${String(baseTitle || '').trim()}`;
}

async function assetTitleExists(baseTitle) {
  const full = buildAssetTitle(baseTitle);
  const existing = await prisma.asset.findFirst({
    where: {
      OR: [{ title: full }, { titleEn: full }],
    },
    select: { id: true },
  });
  return !!existing;
}

async function buildReservedBatchTitleSet(skipIds = []) {
  const skip = Array.isArray(skipIds) ? skipIds.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  const existingItems = await prisma.batchImportItem.findMany({
    where: {
      id: skip.length ? { notIn: skip } : undefined,
      status: { in: ['DRAFT', 'QUEUED', 'PROCESSING', 'COMPLETED'] },
    },
    select: { title: true, folderName: true },
  });

  const used = new Set();
  for (const row of existingItems) {
    const key = normalizeTitleKey(row?.title || row?.folderName || '');
    if (key) used.add(key);
  }
  return used;
}

async function ensureUniqueBatchTitle(rawTitle, reservedKeys) {
  const base = normalizeBaseTitle(rawTitle);
  let attempt = 1;
  while (attempt <= 500) {
    const candidate = attempt === 1 ? base : `${base}${attempt}`;
    const key = normalizeTitleKey(candidate);
    const usedByBatch = key && reservedKeys?.has(key);
    const usedByAsset = await assetTitleExists(candidate);

    if (!usedByBatch && !usedByAsset) {
      if (key) reservedKeys?.add(key);
      return candidate;
    }
    attempt += 1;
  }
  throw new Error('No se pudo generar un título único para batch');
}

// Resolver la ruta de 7z según el SO
const SEVEN_ZIP = (() => {
  if (process.platform !== 'win32') return '7z';
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', '7-Zip', '7z.exe'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return '7z';
})();

function run7z(args) {
  return new Promise((resolve, reject) => {
    // shell: false evita problemas de escape de rutas con espacios en Windows
    const child = spawn(SEVEN_ZIP, args, { shell: false });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)));
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`7z exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

function runUnrar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('unrar', args, { shell: false });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)));
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`unrar exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

function isUnsupportedArchiveMethodError(msg = '') {
  return /unsupported method|no implementado|not implemented/i.test(String(msg || ''));
}

async function extractArchiveWithFallback(archivePath, extractDir) {
  const args7z = ['x', archivePath, `-o${extractDir}`, '-y', '-aoa'];
  try {
    await run7z(args7z);
    return { tool: '7z' };
  } catch (e) {
    const firstErr = String(e?.message || e);
    const ext = path.extname(String(archivePath || '')).toLowerCase();
    if (ext !== '.rar' || !isUnsupportedArchiveMethodError(firstErr)) {
      throw e;
    }

    // Fallback para VPS con p7zip sin soporte completo de RAR.
    try {
      await runUnrar(['x', '-o+', '-y', archivePath, `${extractDir}${path.sep}`]);
      return { tool: 'unrar' };
    } catch (e2) {
      const secondErr = String(e2?.message || e2);
      if (/spawn error:.*unrar/i.test(secondErr)) {
        throw new Error(
          `RAR no soportado por 7z y no existe 'unrar' instalado. Detalle 7z: ${firstErr.slice(0, 180)}`
        );
      }
      throw new Error(`7z: ${firstErr.slice(0, 160)} | unrar: ${secondErr.slice(0, 160)}`);
    }
  }
}

// POST /api/batch-imports/scan
export const scanLocalDirectory = async (req, res) => {
  try {
    if (!fs.existsSync(BATCH_DIR)) {
      fs.mkdirSync(BATCH_DIR, { recursive: true });
    }

    // ─── STEP 0: Auto-descomprimir archivos sueltos en batch_imports/ ───
    const topEntries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const topArchives = topEntries
      .filter(e => e.isFile() && ARCHIVE_EXTS.includes(path.extname(e.name).toLowerCase()));

    for (const arc of topArchives) {
      const arcPath = path.join(BATCH_DIR, arc.name);
      const extractDir = path.join(BATCH_DIR, path.parse(arc.name).name);
      console.log(`[BATCH SCAN] Descomprimiendo ${arc.name} → ${extractDir}`);
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        const extraction = await extractArchiveWithFallback(arcPath, extractDir);
        // Borrar el archivo comprimido original
        fs.unlinkSync(arcPath);
        console.log(`[BATCH SCAN] OK ${arc.name} (tool=${extraction.tool})`);
      } catch (e) {
        console.error(`[BATCH SCAN] Error descomprimiendo ${arc.name}: ${e.message}`);
        try {
          if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
        } catch {}
      }
    }

    // ─── STEP 1: Leer carpetas resultantes ───
    const entries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory()).map(e => e.name);

    if (folders.length === 0) {
      return res.json({ success: true, message: 'No folders found in batch_imports', count: 0 });
    }

    let newlyQueuedCount = 0;
    const reservedKeys = await buildReservedBatchTitleSet();

    for (const folder of folders) {
      // Find or create the master BatchImport record
      let batch = await prisma.batchImport.findUnique({
        where: { folderName: folder }
      });

      if (!batch) {
        batch = await prisma.batchImport.create({
          data: {
            folderName: folder,
            status: 'PENDING'
          }
        });
      }

      // Read subfolders inside this batch folder
      const batchPath = path.join(BATCH_DIR, folder);
      const subEntries = fs.readdirSync(batchPath, { withFileTypes: true });
      const assetFolders = subEntries.filter(e => e.isDirectory()).map(e => e.name);

      let itemsCount = 0;
      // Si no hay subcarpetas, usamos '' para indicar que la ruta base (el batchPath) es el asset en sí mismo.
      const foldersToProcess = assetFolders.length > 0 ? assetFolders : [''];

      for (const assetFolder of foldersToProcess) {
        // Create an item if it doesn't exist
        const existingItem = await prisma.batchImportItem.findFirst({
          where: { batchId: batch.id, folderName: assetFolder }
        });

        const rawBaseTitle = assetFolder ? assetFolder.replace(/_/g, ' ') : folder.replace(/_/g, ' ');

        if (existingItem) {
          // Si ya existe en DRAFT o FAILED, corregir nombre y dejarlo listo para reintento.
          if (existingItem.status === 'DRAFT' || existingItem.status === 'FAILED') {
            const ownTitle = String(existingItem.title || rawBaseTitle || '').trim();
            const currentKey = normalizeTitleKey(ownTitle);
            if (currentKey) reservedKeys.delete(currentKey);
            const uniqueTitle = await ensureUniqueBatchTitle(ownTitle || rawBaseTitle, reservedKeys);

            const updateData = {
              title: uniqueTitle,
            };

            if (existingItem.status === 'FAILED') {
              updateData.status = 'DRAFT';
              updateData.error = null;
              updateData.mainStatus = 'PENDING';
              updateData.backupStatus = 'PENDING';
              updateData.mainProgress = 0;
            }

            await prisma.batchImportItem.update({
              where: { id: existingItem.id },
              data: updateData,
            });
          }
          itemsCount++;
          continue;
        }

        if (!existingItem) {
          const uniqueTitle = await ensureUniqueBatchTitle(rawBaseTitle, reservedKeys);

          // Calculate size
          const assetPath = path.join(batchPath, assetFolder);
          let pesoMB = 0;
          try {
             let totalBytes = 0;
             const traverse = (dir) => {
               const files = fs.readdirSync(dir);
               for (const f of files) {
                 const p = path.join(dir, f);
                 const st = fs.statSync(p);
                 if (st.isDirectory()) traverse(p);
                 else totalBytes += st.size;
               }
             };
             traverse(assetPath);
             pesoMB = Number((totalBytes / (1024 * 1024)).toFixed(2));
          } catch(e) {}

          // Detectar imágenes
          const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
          let images = [];
          try {
            const findImages = (dir) => {
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isFile() && IMAGE_EXTS.includes(path.extname(e.name).toLowerCase())) {
                  images.push(path.relative(UPLOADS_DIR, p).replace(/\\/g, '/'));
                } else if (e.isDirectory()) findImages(p);
              }
            };
            findImages(assetPath);
          } catch {}

          await prisma.batchImportItem.create({
            data: {
              batchId: batch.id,
              folderName: assetFolder, // Si es '', el worker apuntará directo al batchFolder
              title: uniqueTitle,
              pesoMB,
              images: images.length > 0 ? images : [],
              // MOCK FASE 2: Sugerencias "IA" quemadas
              categories: [{ slug: 'anime', name: 'Anime' }],
              tags: [
                { slug: 'anime', name: 'Anime' },
                { slug: 'japon', name: 'Japón' }
              ],
              status: 'DRAFT',
              mainStatus: 'PENDING',
              backupStatus: 'PENDING',
              mainProgress: 0
            }
          });
          newlyQueuedCount++;
        }
        itemsCount++;
      }

      await prisma.batchImport.update({
        where: { id: batch.id },
        data: { totalItems: itemsCount }
      });
    }

    return res.json({
      success: true,
      message: `Scanned and queued ${newlyQueuedCount} new items across batches.`,
      newlyQueuedCount
    });

  } catch (error) {
    console.error('[BATCH IMPORT SCAN ERROR]', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

// GET /api/batch-imports
export const getBatchQueue = async (req, res) => {
  try {
    const queue = await prisma.batchImportItem.findMany({
      include: {
        batch: true
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    return res.json({ success: true, items: queue });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/batch-imports/items/:id  — Actualizar campos de un item
export const updateBatchItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetAccount, title, tags, categories, similarityApproved } = req.body;

    const data = {};
    if (targetAccount !== undefined) data.targetAccount = Number(targetAccount) || null;
    if (title !== undefined) data.title = title;
    if (tags !== undefined) data.tags = tags;
    if (categories !== undefined) data.categories = categories;
    if (similarityApproved !== undefined) data.similarityApproved = !!similarityApproved;

    const updated = await prisma.batchImportItem.update({
      where: { id: Number(id) },
      data
    });

    return res.json({ success: true, item: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/batch-imports/confirm  — Confirmar items para Worker
export const confirmBatchItems = async (req, res) => {
  try {
    const { itemIds } = req.body;
    if (!Array.isArray(itemIds) || !itemIds.length) {
      return res.status(400).json({ success: false, message: 'itemIds requerido' });
    }

    const normalizedIds = itemIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!normalizedIds.length) {
      return res.status(400).json({ success: false, message: 'itemIds inválido' });
    }

    const items = await prisma.batchImportItem.findMany({
      where: { id: { in: normalizedIds } },
      orderBy: { createdAt: 'asc' },
    });

    const targetAccountIds = Array.from(new Set(
      items.map((it) => Number(it.targetAccount || 0)).filter((n) => Number.isFinite(n) && n > 0)
    ));
    const accountRows = targetAccountIds.length
      ? await prisma.megaAccount.findMany({
          where: { id: { in: targetAccountIds } },
          select: { id: true, alias: true, storageUsedMB: true },
        })
      : [];
    const accountById = new Map(accountRows.map((a) => [Number(a.id), a]));
    const plannedExtraByAccount = new Map();

    const reservedKeys = await buildReservedBatchTitleSet(normalizedIds);

    let confirmed = 0;
    const confirmedIds = [];
    const renamed = [];
    const rejectedOverLimit = [];
    for (const item of items) {
      if (!item.targetAccount) continue;

      const accountId = Number(item.targetAccount || 0);
      const acc = accountById.get(accountId);
      if (!acc) continue;

      const usedMb = Number(acc.storageUsedMB || 0);
      const plannedMb = Number(plannedExtraByAccount.get(accountId) || 0);
      const incomingMb = Number(item.pesoMB || 0);
      const projectedMb = usedMb + plannedMb + incomingMb;

      if (projectedMb > MAX_ACCOUNT_UPLOAD_MB) {
        rejectedOverLimit.push({
          itemId: item.id,
          accountId,
          accountAlias: acc.alias,
          usedMb,
          incomingMb,
          projectedMb,
          limitMb: MAX_ACCOUNT_UPLOAD_MB,
        });
        continue;
      }
      plannedExtraByAccount.set(accountId, plannedMb + incomingMb);

      const desired = item.title || item.folderName || `Asset ${item.id}`;
      const uniqueTitle = await ensureUniqueBatchTitle(desired, reservedKeys);

      await prisma.batchImportItem.update({
        where: { id: item.id },
        data: {
          title: uniqueTitle,
          status: 'QUEUED',
          error: null,
          mainStatus: 'PENDING',
          backupStatus: 'PENDING',
          mainProgress: 0,
        }
      });
      confirmed++;
      confirmedIds.push(item.id);
      if (uniqueTitle !== String(desired || '').trim()) {
        renamed.push({ id: item.id, from: String(desired || '').trim(), to: uniqueTitle });
      }
    }

    const message = rejectedOverLimit.length
      ? `Confirmados ${confirmed}. Rechazados por límite de ${MAX_ACCOUNT_UPLOAD_MB}MB: ${rejectedOverLimit.length}`
      : undefined;

    return res.json({ success: true, confirmed, confirmedIds, renamed, rejectedOverLimit, message });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/batch-imports/items/:id  — Borrar item + carpeta del disco
export const deleteBatchItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await prisma.batchImportItem.findUnique({
      where: { id: Number(id) },
      include: { batch: true }
    });

    if (!item) return res.status(404).json({ success: false, message: 'Item no encontrado' });

    // Borrar carpeta del disco
    const folderPath = path.join(BATCH_DIR, item.batch.folderName, item.folderName);
    try {
      if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`[BATCH DELETE] Carpeta borrada: ${folderPath}`);
      }
    } catch (e) {
      console.warn(`[BATCH DELETE] Warn al borrar carpeta: ${e.message}`);
    }

    // Borrar de BD
    await prisma.batchImportItem.delete({ where: { id: Number(id) } });

    // Actualizar totalItems del batch padre
    const remaining = await prisma.batchImportItem.count({ where: { batchId: item.batchId } });
    await prisma.batchImport.update({
      where: { id: item.batchId },
      data: { totalItems: remaining }
    });

    return res.json({ success: true, message: 'Item eliminado y carpeta borrada' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/batch-imports/purge-all
export const purgeAll = async (req, res) => {
  try {
    // 1. Borrar todos los items y batches de la BD
    const deletedItems = await prisma.batchImportItem.deleteMany({});
    const deletedBatches = await prisma.batchImport.deleteMany({});

    // 2. Vaciar la carpeta batch_imports del disco
    if (fs.existsSync(BATCH_DIR)) {
      const entries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(BATCH_DIR, entry.name);
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (e) {
          console.warn(`[BATCH PURGE] No se pudo borrar ${fullPath}: ${e.message}`);
        }
      }
    }

    console.log(`[BATCH PURGE] Eliminados ${deletedItems.count} items, ${deletedBatches.count} batches, carpeta limpiada.`);
    return res.json({ success: true, message: `Eliminados ${deletedItems.count} items y ${deletedBatches.count} batches.` });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/batch-imports/completed
export const purgeCompleted = async (req, res) => {
  try {
    const completedItems = await prisma.batchImportItem.findMany({
      where: { status: 'COMPLETED' },
      select: { id: true, batchId: true, folderName: true },
    });

    if (!completedItems.length) {
      return res.json({ success: true, deletedCount: 0, message: 'No hay items completados para eliminar.' });
    }

    const touchedBatchIds = Array.from(new Set(completedItems.map((i) => Number(i.batchId)).filter((n) => Number.isFinite(n) && n > 0)));

    await prisma.batchImportItem.deleteMany({
      where: { id: { in: completedItems.map((i) => i.id) } },
    });

    for (const batchId of touchedBatchIds) {
      const remaining = await prisma.batchImportItem.count({ where: { batchId } });
      if (remaining <= 0) {
        await prisma.batchImport.delete({ where: { id: batchId } }).catch(() => {});
      } else {
        await prisma.batchImport.update({ where: { id: batchId }, data: { totalItems: remaining } }).catch(() => {});
      }
    }

    console.log(`[BATCH PURGE COMPLETED] Eliminados ${completedItems.length} items COMPLETED.`);
    return res.json({
      success: true,
      deletedCount: completedItems.length,
      message: `Eliminados ${completedItems.length} items completados.`,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/batch-imports/items/:id/retry-proxy
export const retryBatchItemWithAnotherProxy = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido' });
    }

    const item = await prisma.batchImportItem.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ success: false, message: 'Item no encontrado' });

    const isUploading = String(item.mainStatus || '').toUpperCase() === 'UPLOADING' || String(item.backupStatus || '').toUpperCase() === 'UPLOADING';
    if (!isUploading || String(item.status || '').toUpperCase() !== 'PROCESSING') {
      return res.status(409).json({
        success: false,
        message: 'El item no está subiendo en este momento',
      });
    }

    const result = requestBatchProxySwitch(id, 'manual-ui');

    await prisma.batchImportItem.update({
      where: { id },
      data: {
        error: 'Solicitud manual: cancelar subida actual y reintentar con otro proxy...',
      },
    });

    return res.json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

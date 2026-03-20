import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { requestBatchProxySwitch } from '../utils/batchProxySwitch.js';
import { buildBatchScanRequestData } from '../helpers/batchAi/buildBatchScanRequestData.js';
import { callGoogleBatchScan } from '../helpers/batchAi/callGoogleBatchScan.js';

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

function normalizeBilingualTitlePair(rawEs, rawEn, fallback = 'Asset') {
  const es = normalizeBaseTitle(rawEs, '');
  const en = normalizeBaseTitle(rawEn, '');
  const base = es || en || normalizeBaseTitle(fallback, 'Asset');
  return {
    es: es || base,
    en: en || base,
  };
}

function normalizeTitleKey(raw) {
  return normalizeBaseTitle(raw, '').toLowerCase();
}

function buildAssetTitle(baseTitle) {
  return `STL - ${String(baseTitle || '').trim()}`;
}

function normalizeTagLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeTagSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeBatchTagEntry(raw) {
  if (typeof raw === 'string') {
    const label = normalizeTagLabel(raw);
    if (!label) return null;
    return {
      name: label,
      nameEn: label,
      es: label,
      en: label,
      slug: normalizeTagSlug(label),
      slugEn: normalizeTagSlug(label),
    };
  }

  if (!raw || typeof raw !== 'object') return null;

  const id = Number(raw.id || 0);
  const es = normalizeTagLabel(raw.es || raw.name || raw.label || '');
  const en = normalizeTagLabel(raw.en || raw.nameEn || es);
  const slug = normalizeTagSlug(raw.slug || en || es);
  const slugEn = normalizeTagSlug(raw.slugEn || en || es);

  if (!id && !es && !en && !slug) return null;

  return {
    ...(id > 0 ? { id } : {}),
    ...(es ? { name: es, es } : {}),
    ...(en ? { nameEn: en, en } : {}),
    ...(slug ? { slug } : {}),
    ...(slugEn ? { slugEn } : {}),
  };
}

function normalizeBatchTags(rawTags, max = 3) {
  const input = Array.isArray(rawTags) ? rawTags : [];
  const out = [];
  const seen = new Set();

  for (const entry of input) {
    const tag = normalizeBatchTagEntry(entry);
    if (!tag) continue;
    const key =
      normalizeTagSlug(tag.slug) ||
      normalizeTagSlug(tag.slugEn) ||
      normalizeTagSlug(tag.es) ||
      normalizeTagSlug(tag.en) ||
      normalizeTagSlug(tag.name) ||
      normalizeTagSlug(tag.nameEn) ||
      String(tag.id || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }

  return out;
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

async function withTimeout(promise, timeoutMs, timeoutCode = 'OP_TIMEOUT') {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(timeoutCode), { code: timeoutCode })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectFolderStats(dirPath) {
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      try {
        totalBytes += fs.statSync(abs).size;
      } catch {}
    }
  };

  walk(dirPath);
  return { fileCount, totalBytes };
}

function removeDirIfEmpty(absDir) {
  try {
    if (!fs.existsSync(absDir)) return;
    const entries = fs.readdirSync(absDir);
    if (entries.length === 0) fs.rmSync(absDir, { recursive: true, force: true });
  } catch {}
}

// POST /api/batch-imports/scan
export const scanLocalDirectory = async (req, res) => {
  const extractedArchivesThisRun = [];
  try {
    if (!fs.existsSync(BATCH_DIR)) {
      fs.mkdirSync(BATCH_DIR, { recursive: true });
    }

    // ─── STEP 0: Auto-descomprimir archivos sueltos en batch_imports/ ───
    const topEntries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const topArchives = topEntries
      .filter(e => e.isFile() && ARCHIVE_EXTS.includes(path.extname(e.name).toLowerCase()));

    console.info(`[BATCH SCAN][START] batchDir=${BATCH_DIR} archives=${topArchives.length}`);

    let archivesDone = 0;

    for (const arc of topArchives) {
      const arcPath = path.join(BATCH_DIR, arc.name);
      const extractDir = path.join(BATCH_DIR, path.parse(arc.name).name);
      const extractDirExistedBefore = fs.existsSync(extractDir);
      const nextArchiveNumber = archivesDone + 1;
      const startPct = topArchives.length > 0
        ? Math.round((archivesDone / topArchives.length) * 100)
        : 100;
      console.info(`[BATCH SCAN][DECOMPRESS] ${startPct}% (${nextArchiveNumber}/${topArchives.length}) iniciando ${arc.name}`);
      console.log(`[BATCH SCAN] Descomprimiendo ${arc.name} → ${extractDir}`);
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        const extraction = await extractArchiveWithFallback(arcPath, extractDir);
        extractedArchivesThisRun.push({
          archiveName: arc.name,
          arcPath,
          extractDir,
          extractDirExistedBefore,
        });
        archivesDone += 1;
        const donePct = topArchives.length > 0
          ? Math.round((archivesDone / topArchives.length) * 100)
          : 100;
        console.info(`[BATCH SCAN][DECOMPRESS] ${donePct}% (${archivesDone}/${topArchives.length}) completado ${arc.name}`);
        console.log(`[BATCH SCAN] OK ${arc.name} (tool=${extraction.tool})`);
      } catch (e) {
        archivesDone += 1;
        const donePct = topArchives.length > 0
          ? Math.round((archivesDone / topArchives.length) * 100)
          : 100;
        console.warn(`[BATCH SCAN][DECOMPRESS] ${donePct}% (${archivesDone}/${topArchives.length}) fallo ${arc.name}`);
        console.error(`[BATCH SCAN] Error descomprimiendo ${arc.name}: ${e.message}`);
        try {
          if (!extractDirExistedBefore && fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true, force: true });
          }
        } catch {}
      }
    }

    // ─── STEP 1: Leer carpetas resultantes ───
    const entries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory()).map(e => e.name);
    console.info(`[BATCH SCAN][DISCOVERY] carpetas detectadas=${folders.length}`);

    if (folders.length === 0) {
      return res.json({ success: true, message: 'No folders found in batch_imports', count: 0 });
    }

    let newlyQueuedCount = 0;
    const reservedKeys = await buildReservedBatchTitleSet();
    const aiScannedItems = [];

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
        const assetPath = path.join(batchPath, assetFolder);
        const stats = collectFolderStats(assetPath);
        const isEmptyAssetFolder = Number(stats.fileCount || 0) <= 0;

        // Create an item if it doesn't exist
        const existingItem = await prisma.batchImportItem.findFirst({
          where: { batchId: batch.id, folderName: assetFolder }
        });

        if (isEmptyAssetFolder) {
          // Evitar basura en cola: carpeta vacía no se procesa.
          if (existingItem && ['DRAFT', 'FAILED', 'PENDING'].includes(String(existingItem.status || '').toUpperCase())) {
            await prisma.batchImportItem.delete({ where: { id: existingItem.id } }).catch(() => {});
          }

          if (assetFolder) {
            try { if (fs.existsSync(assetPath)) fs.rmSync(assetPath, { recursive: true, force: true }); } catch {}
          } else {
            removeDirIfEmpty(batchPath);
          }

          console.info(`[BATCH SCAN][SKIP_EMPTY] batch=${folder} assetFolder=${assetFolder || '(root)'}`);
          continue;
        }

        const rawBaseTitle = assetFolder ? assetFolder.replace(/_/g, ' ') : folder.replace(/_/g, ' ');

        if (existingItem) {
          // Si ya existe en DRAFT o FAILED, corregir nombre y dejarlo listo para reintento.
          if (existingItem.status === 'DRAFT' || existingItem.status === 'FAILED') {
            const ownTitle = String(existingItem.title || rawBaseTitle || '').trim();
            const currentKey = normalizeTitleKey(ownTitle);
            if (currentKey) reservedKeys.delete(currentKey);
            const uniqueTitle = await ensureUniqueBatchTitle(ownTitle || rawBaseTitle, reservedKeys);
            const bilingualTitle = normalizeBilingualTitlePair(uniqueTitle, existingItem.titleEn || uniqueTitle, rawBaseTitle);

            const updateData = {
              title: bilingualTitle.es,
              titleEn: bilingualTitle.en,
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

          aiScannedItems.push({
            itemId: existingItem.id,
            batchFolder: folder,
            itemFolder: assetFolder || '(root)',
            assetName: rawBaseTitle,
            sourceTitle: existingItem.title || rawBaseTitle,
            sourceTitleEn: existingItem.titleEn || existingItem.title || rawBaseTitle,
            sourcePathHint: assetFolder ? `${folder}/${assetFolder}` : folder,
            sizeMB: Number(existingItem.pesoMB || 0),
            imagesCount: Array.isArray(existingItem.images) ? existingItem.images.length : 0,
            imagePaths: Array.isArray(existingItem.images)
              ? existingItem.images.map((img) => String(img || '').trim()).filter(Boolean)
              : [],
            imageNameHints: Array.isArray(existingItem.images)
              ? existingItem.images.slice(0, 4).map((img) => String(img || '').split('/').pop()).filter(Boolean)
              : [],
            existingStatus: existingItem.status,
          });
          itemsCount++;
          continue;
        }

        if (!existingItem) {
          const uniqueTitle = await ensureUniqueBatchTitle(rawBaseTitle, reservedKeys);
          const bilingualTitle = normalizeBilingualTitlePair(uniqueTitle, uniqueTitle, rawBaseTitle);

          // Calculate size
          let pesoMB = 0;
          try {
             const totalBytes = Number(stats.totalBytes || 0);
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

          const createdItem = await prisma.batchImportItem.create({
            data: {
              batchId: batch.id,
              folderName: assetFolder, // Si es '', el worker apuntará directo al batchFolder
              title: bilingualTitle.es,
              titleEn: bilingualTitle.en,
              pesoMB,
              images: images.length > 0 ? images : [],
              // Fase 2 (preview): todavía no seteamos categorías/tags desde IA.
              status: 'DRAFT',
              mainStatus: 'PENDING',
              backupStatus: 'PENDING',
              mainProgress: 0
            }
          });

          aiScannedItems.push({
            itemId: createdItem.id,
            batchFolder: folder,
            itemFolder: assetFolder || '(root)',
            assetName: rawBaseTitle,
            sourceTitle: bilingualTitle.es,
            sourceTitleEn: bilingualTitle.en,
            sourcePathHint: assetFolder ? `${folder}/${assetFolder}` : folder,
            sizeMB: Number(pesoMB || 0),
            imagesCount: Array.isArray(images) ? images.length : 0,
            imagePaths: Array.isArray(images)
              ? images.map((img) => String(img || '').trim()).filter(Boolean)
              : [],
            imageNameHints: Array.isArray(images)
              ? images.slice(0, 4).map((img) => String(img || '').split('/').pop()).filter(Boolean)
              : [],
            existingStatus: 'NEW',
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

    console.info(`[BATCH SCAN][DISCOVERY] items preparados para IA=${aiScannedItems.length} nuevos=${newlyQueuedCount}`);

    let aiTimedOut = false;
    try {
      const [categoriesCatalog, tagsCatalog] = await Promise.all([
        prisma.category.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, slug: true, nameEn: true, slugEn: true },
        }),
        prisma.tag.findMany({
          orderBy: { name: 'asc' },
          select: { id: true, name: true, slug: true, nameEn: true, slugEn: true },
        }),
      ]);

      const aiPayload = buildBatchScanRequestData(req, {
        foldersCount: folders.length,
        newlyQueuedCount,
        scannedItems: aiScannedItems,
      }, {
        categories: categoriesCatalog,
        tags: tagsCatalog,
      });
      const aiTimeoutMs = Math.max(10_000, Number(process.env.BATCH_SCAN_AI_TIMEOUT_MS) || 45_000);
      console.info(`[BATCH SCAN][AI] iniciando clasificación items=${aiScannedItems.length} timeoutMs=${aiTimeoutMs}`);
      let aiResult = [];
      try {
        aiResult = await withTimeout(
          callGoogleBatchScan(aiPayload),
          aiTimeoutMs,
          'BATCH_AI_SCAN_TIMEOUT'
        );
      } catch (aiErr) {
        aiTimedOut = String(aiErr?.code || aiErr?.message || '').includes('BATCH_AI_SCAN_TIMEOUT');
        if (aiTimedOut) {
          console.warn(`[BATCH][AI][SCAN][TIMEOUT] timeoutMs=${aiTimeoutMs} items=${aiScannedItems.length}`);
        } else {
          console.error('[BATCH][AI][SCAN][WARN]', aiErr?.message || aiErr);
        }
        aiResult = [];
      }

      const aiSuggestions = Array.isArray(aiResult) ? aiResult : [];
      if (aiSuggestions.length > 0) {
        let applied = 0;
        let skipped = 0;
        let failed = 0;
        for (const suggestion of aiSuggestions) {
          const itemId = Number(suggestion?.itemId || 0);
          if (!itemId) continue;

          const nameEs = String(suggestion?.nombre?.es || '').trim();
          const nameEn = String(suggestion?.nombre?.en || '').trim();
          const safeName = normalizeBilingualTitlePair(nameEs, nameEn, 'Asset');

          const tags = Array.isArray(suggestion?.tags)
            ? suggestion.tags.slice(0, 3)
            : [];

          const categoryObj = suggestion?.categoria && typeof suggestion.categoria === 'object'
            ? suggestion.categoria
            : null;

          const data = {
            title: safeName.es,
            titleEn: safeName.en,
          };

          const normalizedTags = normalizeBatchTags(tags, 3);
          if (normalizedTags.length > 0) data.tags = normalizedTags;
          if (categoryObj && (categoryObj.id || categoryObj.slug)) {
            data.categories = [categoryObj];
          }

          try {
            const current = await prisma.batchImportItem.findUnique({
              where: { id: itemId },
              select: { id: true, status: true },
            });

            if (!current) {
              skipped += 1;
              continue;
            }

            const statusNow = String(current.status || '').toUpperCase();
            if (!['DRAFT', 'FAILED', 'PENDING'].includes(statusNow)) {
              skipped += 1;
              continue;
            }

            await prisma.batchImportItem.update({
              where: { id: itemId },
              data,
            });
            applied += 1;
          } catch (applyErr) {
            failed += 1;
            console.error('[BATCH][AI][APPLY_WARN]', applyErr?.message || applyErr);
            console.error('[BATCH][AI][APPLY_WARN][ITEM]', {
              itemId,
              hasTags: Array.isArray(data.tags) ? data.tags.length : 0,
              hasCategories: Array.isArray(data.categories) ? data.categories.length : 0,
            });
          }
        }
        console.log(`[BATCH][AI][APPLY] sugerencias aplicadas=${applied} skip=${skipped} fail=${failed} total=${aiSuggestions.length}`);
      }
    } catch (e) {
      console.error('[BATCH][AI][SCAN][WARN]', e?.message || e);
    }

    // Solo borramos comprimidos originales cuando TODO el scan terminó correctamente.
    let deletedArchivesCount = 0;
    for (const extracted of extractedArchivesThisRun) {
      try {
        if (fs.existsSync(extracted.arcPath)) {
          fs.unlinkSync(extracted.arcPath);
          deletedArchivesCount += 1;
        }
      } catch (e) {
        console.warn(`[BATCH SCAN] Warn borrando comprimido ${extracted.archiveName}: ${e.message}`);
      }
    }

    console.info(`[BATCH SCAN][DONE] nuevos=${newlyQueuedCount} comprimidos-borrados=${deletedArchivesCount}/${extractedArchivesThisRun.length} aiTimedOut=${aiTimedOut ? 'yes' : 'no'}`);

    return res.json({
      success: true,
      message: `Scanned and queued ${newlyQueuedCount} new items across batches.`,
      newlyQueuedCount,
      deletedArchivesCount,
      processedArchivesCount: extractedArchivesThisRun.length,
      aiTimedOut
    });

  } catch (error) {
    // Fallo global: limpiar solo lo extraído en esta corrida y conservar comprimidos para reintento.
    for (const extracted of extractedArchivesThisRun) {
      try {
        if (!extracted.extractDirExistedBefore && fs.existsSync(extracted.extractDir)) {
          fs.rmSync(extracted.extractDir, { recursive: true, force: true });
        }
      } catch (cleanupErr) {
        console.warn(`[BATCH SCAN] Rollback warn ${extracted.extractDir}: ${cleanupErr.message}`);
      }
    }

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
    const { targetAccount, title, titleEn, tags, categories, similarityApproved } = req.body;

    const data = {};
    if (targetAccount !== undefined) data.targetAccount = Number(targetAccount) || null;
    if (title !== undefined) data.title = title;
    if (titleEn !== undefined) data.titleEn = titleEn;
    if (tags !== undefined) data.tags = normalizeBatchTags(tags, 3);
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

      const desired = item.title || item.titleEn || item.folderName || `Asset ${item.id}`;
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

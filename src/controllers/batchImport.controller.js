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

let batchScanRunSeq = 0;
let batchScanStatus = {
  runId: 0,
  status: 'idle',
  phase: 'idle',
  message: 'Sin escaneo en ejecución.',
  current: 0,
  total: 0,
  percent: 0,
  startedAt: null,
  updatedAt: Date.now(),
  finishedAt: null,
  error: null,
  counters: {
    archives: { done: 0, total: 0 },
    folders: { done: 0, total: 0 },
    items: { done: 0, total: 0 },
  },
  result: null,
};

function sanitizeCounterPair(raw = {}, fallback = {}) {
  const doneRaw = Number(raw?.done ?? fallback?.done ?? 0);
  const totalRaw = Number(raw?.total ?? fallback?.total ?? 0);
  const done = Number.isFinite(doneRaw) ? Math.max(0, Math.floor(doneRaw)) : 0;
  const total = Number.isFinite(totalRaw) ? Math.max(0, Math.floor(totalRaw)) : 0;
  return { done, total };
}

function computePercent(current, total) {
  const c = Number(current || 0);
  const t = Number(total || 0);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((c / t) * 100)));
}

function setBatchScanStatus(patch = {}, options = {}) {
  const prev = batchScanStatus;
  const next = {
    ...prev,
    ...patch,
    counters: {
      archives: sanitizeCounterPair(patch?.counters?.archives, prev?.counters?.archives),
      folders: sanitizeCounterPair(patch?.counters?.folders, prev?.counters?.folders),
      items: sanitizeCounterPair(patch?.counters?.items, prev?.counters?.items),
    },
    updatedAt: Date.now(),
  };

  if (!Number.isFinite(Number(next.current))) next.current = Number(prev.current || 0);
  if (!Number.isFinite(Number(next.total))) next.total = Number(prev.total || 0);

  if (patch?.percent == null) {
    next.percent = computePercent(next.current, next.total);
  } else {
    const explicit = Number(patch.percent);
    next.percent = Number.isFinite(explicit) ? Math.max(0, Math.min(100, Math.round(explicit))) : computePercent(next.current, next.total);
  }

  batchScanStatus = next;

  if (options?.log) {
    console.info(
      `[BATCH SCAN][STATUS] run=${next.runId} status=${next.status} phase=${next.phase} ` +
      `pct=${next.percent}% step=${next.current}/${next.total} msg=${next.message}`
    );
  }

  return batchScanStatus;
}

function beginBatchScanStatus() {
  batchScanRunSeq += 1;
  batchScanStatus = {
    runId: batchScanRunSeq,
    status: 'running',
    phase: 'initializing',
    message: 'Iniciando escaneo de batch_imports...',
    current: 0,
    total: 1,
    percent: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    error: null,
    counters: {
      archives: { done: 0, total: 0 },
      folders: { done: 0, total: 0 },
      items: { done: 0, total: 0 },
    },
    result: null,
  };
  console.info(`[BATCH SCAN][STATUS] run=${batchScanStatus.runId} status=running phase=initializing`);
  return batchScanStatus;
}

function completeBatchScanStatus(patch = {}, status = 'done') {
  return setBatchScanStatus(
    {
      status,
      phase: status,
      finishedAt: Date.now(),
      ...(patch || {}),
    },
    { log: true }
  );
}

function normalizeBaseTitle(raw, fallback = 'Asset') {
  const cleaned = String(raw || '')
    .replace(TITLE_PREFIX_RE, '')
    // Quitar extensiones típicas de archivos comprimidos al final del título.
    .replace(/\.(zip|rar|7z|7zs|tar|gz|tgz)(\d+)?$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function buildDefaultBilingualDescription(rawEs, rawEn, fallback = 'asset') {
  const pair = normalizeBilingualTitlePair(rawEs, rawEn, fallback);
  const esBase = String(pair.es || fallback || 'asset').trim();
  const enBase = String(pair.en || esBase || fallback || 'asset').trim();
  return {
    es: `Modelo STL de ${esBase}.`,
    en: `STL model of ${enBase}.`,
  };
}

function normalizeTitleKey(raw) {
  return normalizeBaseTitle(raw, '').toLowerCase();
}

function toTitleCase(raw) {
  return String(raw || '')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();
}

function beautifySuggestedTitle(raw, fallback = 'Asset') {
  const normalized = normalizeBaseTitle(raw, fallback)
    .replace(/[\[\](){}]/g, ' ')
    .replace(/\b(v\d+|final|fix|stl|3d|model|modelo|pack|bundle|archivo|file)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return toTitleCase(normalized || normalizeBaseTitle(fallback, 'Asset'));
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
    const candidate = attempt === 1 ? base : `${base} ${attempt}`;
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

function run7z(args, options = {}) {
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  return new Promise((resolve, reject) => {
    // shell: false evita problemas de escape de rutas con espacios en Windows
    const child = spawn(SEVEN_ZIP, args, { shell: false });
    let out = '', err = '';
    let stdoutCarry = '';
    let stderrCarry = '';

    const emitProgressFromChunk = (chunkText, source) => {
      if (!onProgress) return;
      const lines = String(chunkText || '').split(/[\r\n]+/).map((l) => String(l || '').trim()).filter(Boolean);
      for (const ln of lines) {
        const pctMatch = ln.match(/(?:^|\s)(\d{1,3})%/);
        const pct = pctMatch ? Math.max(0, Math.min(100, Number(pctMatch[1] || 0))) : null;

        let file = '';
        const fileMatch = ln.match(/(?:extracting|extract)\s+(.+)$/i);
        if (fileMatch) {
          const candidate = String(fileMatch[1] || '').trim();
          if (candidate && !/^archive\s*:/i.test(candidate) && !/^path\s*=\s*/i.test(candidate)) {
            file = candidate;
          }
        }

        if (pct != null || file) {
          try { onProgress({ percent: pct, file, line: ln, tool: '7z', source }); } catch {}
        }
      }
    };

    child.stdout.on('data', d => {
      const txt = d.toString();
      out += txt;
      stdoutCarry += txt;
      const parts = stdoutCarry.split(/[\r\n]+/);
      stdoutCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stdout');
    });

    child.stderr.on('data', d => {
      const txt = d.toString();
      err += txt;
      stderrCarry += txt;
      const parts = stderrCarry.split(/[\r\n]+/);
      stderrCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stderr');
    });

    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)));
    child.on('close', code => {
      emitProgressFromChunk(stdoutCarry, 'stdout-tail');
      emitProgressFromChunk(stderrCarry, 'stderr-tail');
      if (code === 0) resolve(out);
      else reject(new Error(`7z exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

function runUnrar(args, options = {}) {
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  return new Promise((resolve, reject) => {
    const child = spawn('unrar', args, { shell: false });
    let out = '', err = '';
    let stdoutCarry = '';
    let stderrCarry = '';

    const emitProgressFromChunk = (chunkText, source) => {
      if (!onProgress) return;
      const lines = String(chunkText || '').split(/[\r\n]+/).map((l) => String(l || '').trim()).filter(Boolean);
      for (const ln of lines) {
        const pctMatch = ln.match(/(?:^|\s)(\d{1,3})%/);
        const pct = pctMatch ? Math.max(0, Math.min(100, Number(pctMatch[1] || 0))) : null;
        const fileMatch = ln.match(/(?:extracting|extract)\s+(.+)$/i);
        const file = fileMatch ? String(fileMatch[1] || '').trim() : '';
        if (pct != null || file) {
          try { onProgress({ percent: pct, file, line: ln, tool: 'unrar', source }); } catch {}
        }
      }
    };

    child.stdout.on('data', d => {
      const txt = d.toString();
      out += txt;
      stdoutCarry += txt;
      const parts = stdoutCarry.split(/[\r\n]+/);
      stdoutCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stdout');
    });

    child.stderr.on('data', d => {
      const txt = d.toString();
      err += txt;
      stderrCarry += txt;
      const parts = stderrCarry.split(/[\r\n]+/);
      stderrCarry = parts.pop() || '';
      emitProgressFromChunk(parts.join('\n'), 'stderr');
    });

    child.on('error', (e) => reject(new Error(`Spawn error: ${e.message}`)));
    child.on('close', code => {
      emitProgressFromChunk(stdoutCarry, 'stdout-tail');
      emitProgressFromChunk(stderrCarry, 'stderr-tail');
      if (code === 0) resolve(out);
      else reject(new Error(`unrar exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

function isUnsupportedArchiveMethodError(msg = '') {
  return /unsupported method|no implementado|not implemented/i.test(String(msg || ''));
}

async function extractArchiveWithFallback(archivePath, extractDir, options = {}) {
  const args7z = ['x', archivePath, `-o${extractDir}`, '-y', '-aoa', '-bb1', '-bsp1'];
  try {
    await run7z(args7z, options);
    return { tool: '7z' };
  } catch (e) {
    const firstErr = String(e?.message || e);
    const ext = path.extname(String(archivePath || '')).toLowerCase();
    if (ext !== '.rar' || !isUnsupportedArchiveMethodError(firstErr)) {
      throw e;
    }

    // Fallback para VPS con p7zip sin soporte completo de RAR.
    try {
      await runUnrar(['x', '-o+', '-y', archivePath, `${extractDir}${path.sep}`], options);
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

function directoryHasEntries(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return Array.isArray(entries) && entries.length > 0;
  } catch {
    return false;
  }
}

function getShallowDirSnapshot(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let dirs = 0;
    let files = 0;
    for (const e of entries) {
      if (e.isDirectory()) dirs += 1;
      else if (e.isFile()) files += 1;
    }
    return {
      exists: true,
      entries: entries.length,
      dirs,
      files,
    };
  } catch {
    return {
      exists: false,
      entries: 0,
      dirs: 0,
      files: 0,
    };
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

function unpackAiScanResult(rawValue) {
  if (Array.isArray(rawValue)) {
    return { suggestions: rawValue, stats: null };
  }
  if (!rawValue || typeof rawValue !== 'object') {
    return { suggestions: [], stats: null };
  }

  const suggestions = Array.isArray(rawValue.suggestions)
    ? rawValue.suggestions
    : Array.isArray(rawValue.items)
      ? rawValue.items
      : [];
  const stats = rawValue.stats && typeof rawValue.stats === 'object' ? rawValue.stats : null;

  return { suggestions, stats };
}

async function applyAiSuggestionsToBatchItems(rawSuggestions, { source = 'manual-retry-ai' } = {}) {
  const aiSuggestions = Array.isArray(rawSuggestions) ? rawSuggestions : [];
  if (aiSuggestions.length <= 0) {
    console.log(`[BATCH][AI][APPLY] source=${source} sugerencias=0`);
    return { applied: 0, skipped: 0, failed: 0, total: 0 };
  }

  const suggestionItemIds = Array.from(new Set(
    aiSuggestions
      .map((s) => Number(s?.itemId || 0))
      .filter((n) => Number.isFinite(n) && n > 0)
  ));
  const reservedKeys = await buildReservedBatchTitleSet(suggestionItemIds);

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const suggestion of aiSuggestions) {
    const itemId = Number(suggestion?.itemId || 0);
    if (!itemId) continue;

    const current = await prisma.batchImportItem.findUnique({
      where: { id: itemId },
      select: { id: true, status: true, title: true, titleEn: true, folderName: true },
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

    const nameEs = String(suggestion?.nombre?.es || '').trim();
    const nameEn = String(suggestion?.nombre?.en || '').trim();
    const fallbackBase = current.title || current.folderName || 'Asset';
    let safeName = normalizeBilingualTitlePair(nameEs, nameEn, fallbackBase);
    if (normalizeTitleKey(safeName.es) === normalizeTitleKey(fallbackBase)) {
      const pretty = beautifySuggestedTitle(fallbackBase, 'Asset');
      safeName = normalizeBilingualTitlePair(pretty, safeName.en || pretty, pretty);
    }

    const uniqueEs = await ensureUniqueBatchTitle(safeName.es, reservedKeys);
    safeName = normalizeBilingualTitlePair(uniqueEs, safeName.en || uniqueEs, uniqueEs);

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

    const descEs = String(suggestion?.descripcion?.es || '').trim();
    const descEn = String(suggestion?.descripcion?.en || '').trim();
    if (descEs) data.description = descEs;
    if (descEn) data.descriptionEn = descEn;

    const normalizedTags = normalizeBatchTags(tags, 3);
    if (normalizedTags.length > 0) data.tags = normalizedTags;
    if (categoryObj && (categoryObj.id || categoryObj.slug)) {
      data.categories = [categoryObj];
    }

    try {
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
        hasDescription: !!(data.description || data.descriptionEn),
      });
    }
  }

  console.log(`[BATCH][AI][APPLY] source=${source} sugerencias aplicadas=${applied} skip=${skipped} fail=${failed} total=${aiSuggestions.length}`);
  return { applied, skipped, failed, total: aiSuggestions.length };
}

function buildAiScanItemFromBatchItem(item) {
  const batchFolder = String(item?.batch?.folderName || '').trim();
  const itemFolder = String(item?.folderName || '').trim();
  const sourcePathHint = itemFolder
    ? (batchFolder ? `${batchFolder}/${itemFolder}` : itemFolder)
    : (batchFolder || itemFolder || 'batch-item');

  const sourceTitle = String(item?.title || itemFolder || batchFolder || `Asset ${item?.id || ''}`).trim() || 'Asset';
  const sourceTitleEn = String(item?.titleEn || sourceTitle).trim() || sourceTitle;
  const imagePaths = Array.isArray(item?.images)
    ? item.images.map((img) => String(img || '').trim()).filter(Boolean)
    : [];

  return {
    itemId: Number(item?.id || 0) || null,
    batchFolder,
    itemFolder: itemFolder || '(root)',
    assetName: sourceTitle,
    sourceTitle,
    sourceTitleEn,
    sourcePathHint,
    sizeMB: Number(item?.pesoMB || 0),
    imagesCount: imagePaths.length,
    imagePaths,
    imageNameHints: imagePaths.slice(0, 4).map((img) => String(img || '').split('/').pop()).filter(Boolean),
    existingStatus: String(item?.status || 'DRAFT'),
  };
}

// POST /api/batch-imports/scan
export const scanLocalDirectory = async (req, res) => {
  const extractedArchivesThisRun = [];
  let stopScanWatchdog = () => {};
  try {
    if (String(batchScanStatus?.status || '').toLowerCase() === 'running') {
      return res.status(409).json({
        success: false,
        message: 'Ya existe un escaneo en progreso.',
        scan: batchScanStatus,
      });
    }

    const startedStatus = beginBatchScanStatus();
    const activeRunId = Number(startedStatus?.runId || 0);
    const scanStartedAt = Number(startedStatus?.startedAt || Date.now());
    const warnAfterSecRaw = Number(process.env.BATCH_SCAN_STALL_WARN_S || 40);
    const errorAfterSecRaw = Number(process.env.BATCH_SCAN_STALL_ERROR_S || 120);
    const watchdogEveryMsRaw = Number(process.env.BATCH_SCAN_WATCHDOG_MS || 10000);
    const warnAfterSec = Number.isFinite(warnAfterSecRaw) && warnAfterSecRaw > 0 ? Math.floor(warnAfterSecRaw) : 40;
    const errorAfterSec = Number.isFinite(errorAfterSecRaw) && errorAfterSecRaw > warnAfterSec ? Math.floor(errorAfterSecRaw) : 120;
    const watchdogEveryMs = Number.isFinite(watchdogEveryMsRaw) && watchdogEveryMsRaw >= 2000 ? Math.floor(watchdogEveryMsRaw) : 10000;

    const watchdogId = setInterval(() => {
      const snap = batchScanStatus;
      if (Number(snap?.runId || 0) !== activeRunId) return;

      const now = Date.now();
      const staleSec = Math.max(0, Math.floor((now - Number(snap?.updatedAt || now)) / 1000));
      const elapsedSec = Math.max(0, Math.floor((now - scanStartedAt) / 1000));
      const line =
        `[BATCH SCAN][HEARTBEAT] run=${snap.runId} phase=${snap.phase} status=${snap.status} ` +
        `step=${snap.current}/${snap.total} pct=${snap.percent}% ` +
        `archives=${snap?.counters?.archives?.done || 0}/${snap?.counters?.archives?.total || 0} ` +
        `folders=${snap?.counters?.folders?.done || 0}/${snap?.counters?.folders?.total || 0} ` +
        `items=${snap?.counters?.items?.done || 0}/${snap?.counters?.items?.total || 0} ` +
        `lastUpdate=${staleSec}s elapsed=${elapsedSec}s msg=${snap.message}`;

      if (staleSec >= errorAfterSec) {
        console.error(line.replace('[HEARTBEAT]', '[STALL]'));
      } else if (staleSec >= warnAfterSec) {
        console.warn(line.replace('[HEARTBEAT]', '[SLOW]'));
      } else {
        console.info(line);
      }
    }, watchdogEveryMs);

    stopScanWatchdog = () => {
      try { clearInterval(watchdogId); } catch {}
    };

    if (!fs.existsSync(BATCH_DIR)) {
      fs.mkdirSync(BATCH_DIR, { recursive: true });
    }

    setBatchScanStatus(
      {
        phase: 'initializing',
        message: 'Directorio batch_imports preparado.',
        current: 1,
        total: 1,
      },
      { log: true }
    );

    // ─── STEP 0: Auto-descomprimir archivos sueltos en batch_imports/ ───
    const topEntries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const topArchives = topEntries
      .filter(e => e.isFile() && ARCHIVE_EXTS.includes(path.extname(e.name).toLowerCase()));

    setBatchScanStatus(
      {
        phase: topArchives.length > 0 ? 'decompress' : 'discovery',
        message: topArchives.length > 0
          ? `Descomprimiendo ${topArchives.length} archivo(s) detectados...`
          : 'Sin comprimidos sueltos. Iniciando discovery...',
        current: 0,
        total: Math.max(topArchives.length, 1),
        counters: {
          archives: { done: 0, total: topArchives.length },
        },
      },
      { log: true }
    );

    console.info(`[BATCH SCAN][START] batchDir=${BATCH_DIR} archives=${topArchives.length}`);

    let archivesDone = 0;
    const rawExtractTimeout = Number(process.env.BATCH_SCAN_EXTRACT_TIMEOUT_MS || 0);
    const extractTimeoutMs = Number.isFinite(rawExtractTimeout) && rawExtractTimeout > 0 ? rawExtractTimeout : 0;

    for (const arc of topArchives) {
      const arcStartedAt = Date.now();
      const arcPath = path.join(BATCH_DIR, arc.name);
      const extractDir = path.join(BATCH_DIR, path.parse(arc.name).name);
      const extractDirExistedBefore = fs.existsSync(extractDir);
      const extractDirHasEntries = extractDirExistedBefore && directoryHasEntries(extractDir);
      let arcSizeMB = 0;
      try {
        arcSizeMB = Number((Number(fs.statSync(arcPath).size || 0) / (1024 * 1024)).toFixed(2));
      } catch {}
      const nextArchiveNumber = archivesDone + 1;
      const startPct = topArchives.length > 0
        ? Math.round((archivesDone / topArchives.length) * 100)
        : 100;
      console.info(`[BATCH SCAN][DECOMPRESS] ${startPct}% (${nextArchiveNumber}/${topArchives.length}) iniciando ${arc.name} sizeMB=${arcSizeMB}`);

      if (extractDirHasEntries) {
        archivesDone += 1;
        const elapsedMs = Date.now() - arcStartedAt;
        const donePct = topArchives.length > 0
          ? Math.round((archivesDone / topArchives.length) * 100)
          : 100;
        console.info(`[BATCH SCAN][DECOMPRESS] ${donePct}% (${archivesDone}/${topArchives.length}) skip ${arc.name} (destino ya extraído) ms=${elapsedMs}`);
        setBatchScanStatus(
          {
            phase: 'decompress',
            message: `Saltando ${arc.name}: carpeta destino ya contiene archivos`,
            current: archivesDone,
            total: Math.max(topArchives.length, 1),
            counters: {
              archives: { done: archivesDone, total: topArchives.length },
            },
          },
          { log: true }
        );
        continue;
      }

      console.log(`[BATCH SCAN] Descomprimiendo ${arc.name} → ${extractDir}`);
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        const decompressStartAt = Date.now();
        const heartbeat = setInterval(() => {
          const elapsedSec = Math.max(1, Math.floor((Date.now() - decompressStartAt) / 1000));
          const shouldLogHeartbeat = elapsedSec % 30 === 0;
          const partial = getShallowDirSnapshot(extractDir);
          const currentPercentRaw = Number(batchScanStatus?.percent);
          const currentPercent = Number.isFinite(currentPercentRaw)
            ? Math.max(0, Math.min(100, Math.floor(currentPercentRaw)))
            : 0;
          setBatchScanStatus(
            {
              phase: 'decompress',
              message: `Descomprimiendo ${arc.name} (${nextArchiveNumber}/${topArchives.length}) · ${elapsedSec}s · outDirs=${partial.dirs} outFiles=${partial.files}`,
              current: archivesDone,
              total: Math.max(topArchives.length, 1),
              percent: currentPercent,
              counters: {
                archives: { done: archivesDone, total: topArchives.length },
              },
            },
            { log: shouldLogHeartbeat }
          );
        }, 5000);

        let extraction;
        let lastExtractPercent = -1;
        let lastProgressLogAt = 0;
        let lastProgressFile = '';
        try {
          extraction = await withTimeout(
            extractArchiveWithFallback(arcPath, extractDir, {
              onProgress: (progress) => {
                const now = Date.now();
                const pctRaw = Number(progress?.percent);
                const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, Math.floor(pctRaw))) : null;
                const file = String(progress?.file || '').trim();

                const shouldUpdateByPct = pct != null && pct !== lastExtractPercent;
                const shouldUpdateByTime = now - lastProgressLogAt >= 8000;
                const shouldUpdateByFile = !!file && file !== lastProgressFile;
                if (!shouldUpdateByPct && !shouldUpdateByTime && !shouldUpdateByFile) return;

                if (pct != null) lastExtractPercent = pct;
                if (file) lastProgressFile = file;
                lastProgressLogAt = now;

                const elapsedSec = Math.max(1, Math.floor((now - decompressStartAt) / 1000));
                const partial = getShallowDirSnapshot(extractDir);
                const globalPercent = topArchives.length > 0
                  ? Math.max(0, Math.min(100, Math.round(((archivesDone + ((pct ?? 0) / 100)) / topArchives.length) * 100)))
                  : (pct ?? 0);

                const fileHint = file ? ` · file=${file}` : '';
                setBatchScanStatus(
                  {
                    phase: 'decompress',
                    message: `Descomprimiendo ${arc.name} (${nextArchiveNumber}/${topArchives.length}) · ${pct != null ? `${pct}%` : 'trabajando'}${fileHint} · ${elapsedSec}s · outDirs=${partial.dirs} outFiles=${partial.files}`,
                    current: archivesDone,
                    total: Math.max(topArchives.length, 1),
                    percent: globalPercent,
                    counters: {
                      archives: { done: archivesDone, total: topArchives.length },
                    },
                  },
                  { log: pct != null ? (pct % 10 === 0) : shouldUpdateByTime }
                );

                if (shouldUpdateByPct || shouldUpdateByFile) {
                  console.info(
                    `[BATCH SCAN][DECOMPRESS][PROGRESS] arc=${arc.name} ` +
                    `pct=${pct != null ? `${pct}%` : '-'} elapsed=${elapsedSec}s file=${file || '-'} outDirs=${partial.dirs} outFiles=${partial.files}`
                  );
                }
              }
            }),
            extractTimeoutMs,
            'BATCH_SCAN_EXTRACT_TIMEOUT'
          );
        } finally {
          clearInterval(heartbeat);
        }

        extractedArchivesThisRun.push({
          archiveName: arc.name,
          arcPath,
          extractDir,
          extractDirExistedBefore,
        });
        archivesDone += 1;
        const elapsedMs = Date.now() - arcStartedAt;
        const donePct = topArchives.length > 0
          ? Math.round((archivesDone / topArchives.length) * 100)
          : 100;
        console.info(`[BATCH SCAN][DECOMPRESS] ${donePct}% (${archivesDone}/${topArchives.length}) completado ${arc.name} tool=${extraction.tool} ms=${elapsedMs}`);
        console.log(`[BATCH SCAN] OK ${arc.name} (tool=${extraction.tool})`);
        setBatchScanStatus(
          {
            phase: 'decompress',
            message: `Descompresión ${archivesDone}/${topArchives.length}: ${arc.name}`,
            current: archivesDone,
            total: Math.max(topArchives.length, 1),
            counters: {
              archives: { done: archivesDone, total: topArchives.length },
            },
          },
          { log: true }
        );
      } catch (e) {
        archivesDone += 1;
        const elapsedMs = Date.now() - arcStartedAt;
        const donePct = topArchives.length > 0
          ? Math.round((archivesDone / topArchives.length) * 100)
          : 100;
        console.warn(`[BATCH SCAN][DECOMPRESS] ${donePct}% (${archivesDone}/${topArchives.length}) fallo ${arc.name} ms=${elapsedMs}`);
        const isExtractTimeout = String(e?.code || e?.message || '').includes('BATCH_SCAN_EXTRACT_TIMEOUT');
        const errMsg = isExtractTimeout
          ? `Timeout descomprimiendo ${arc.name}. Ajusta BATCH_SCAN_EXTRACT_TIMEOUT_MS si necesitas más tiempo.`
          : `Error descomprimiendo ${arc.name}: ${e.message}`;
        console.error(`[BATCH SCAN] ${errMsg}`);
        setBatchScanStatus(
          {
            phase: 'decompress',
            message: `${isExtractTimeout ? 'Timeout' : 'Fallo'} al descomprimir ${arc.name} (${archivesDone}/${topArchives.length})`,
            current: archivesDone,
            total: Math.max(topArchives.length, 1),
            counters: {
              archives: { done: archivesDone, total: topArchives.length },
            },
          },
          { log: true }
        );
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

    const folderPlans = folders.map((folder) => {
      const batchPath = path.join(BATCH_DIR, folder);
      let subEntries = [];
      try {
        subEntries = fs.readdirSync(batchPath, { withFileTypes: true });
      } catch {
        subEntries = [];
      }
      const assetFolders = subEntries.filter((e) => e.isDirectory()).map((e) => e.name);
      const foldersToProcess = assetFolders.length > 0 ? assetFolders : [''];
      return { folder, batchPath, foldersToProcess };
    });

    const totalDiscoveryItems = folderPlans.reduce((acc, p) => acc + p.foldersToProcess.length, 0);

    setBatchScanStatus(
      {
        phase: 'discovery',
        message: `Discovery de ${folderPlans.length} lote(s) y ${totalDiscoveryItems} carpeta(s) de assets...`,
        current: 0,
        total: Math.max(totalDiscoveryItems, 1),
        counters: {
          archives: { done: archivesDone, total: topArchives.length },
          folders: { done: 0, total: folderPlans.length },
          items: { done: 0, total: totalDiscoveryItems },
        },
      },
      { log: true }
    );

    if (folders.length === 0) {
      completeBatchScanStatus({
        message: 'No se encontraron carpetas en batch_imports.',
        current: 1,
        total: 1,
        percent: 100,
        result: {
          newlyQueuedCount: 0,
          scannedItemsCount: 0,
          deletedArchivesCount: 0,
          processedArchivesCount: extractedArchivesThisRun.length,
        },
      });
      return res.json({ success: true, message: 'No folders found in batch_imports', count: 0 });
    }

    let newlyQueuedCount = 0;
    const reservedStartedAt = Date.now();
    setBatchScanStatus(
      {
        phase: 'discovery',
        message: 'Discovery · DB: cargando títulos reservados del batch...',
      },
      { log: true }
    );
    const reservedKeys = await buildReservedBatchTitleSet();
    console.info(`[BATCH SCAN][DISCOVERY] reservedTitles=${reservedKeys.size} ms=${Date.now() - reservedStartedAt}`);
    const aiScannedItems = [];

    let processedDiscoveryItems = 0;
    for (let folderIdx = 0; folderIdx < folderPlans.length; folderIdx += 1) {
      const folderStartedAt = Date.now();
      const { folder, batchPath, foldersToProcess } = folderPlans[folderIdx];
      console.info(`[BATCH SCAN][FOLDER][START] (${folderIdx + 1}/${folderPlans.length}) folder=${folder} items=${foldersToProcess.length}`);
      setBatchScanStatus(
        {
          phase: 'discovery',
          message: `Batch ${folder} · DB: buscando/creando cabecera de lote`,
          counters: {
            folders: { done: folderIdx, total: folderPlans.length },
            items: { done: processedDiscoveryItems, total: totalDiscoveryItems },
            archives: { done: archivesDone, total: topArchives.length },
          },
        },
        { log: false }
      );
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

      let itemsCount = 0;

      for (const assetFolder of foldersToProcess) {
        const itemStartedAt = Date.now();
        processedDiscoveryItems += 1;
        const phaseItemLabel = assetFolder ? `${folder}/${assetFolder}` : `${folder}/(root)`;
        console.info(`[BATCH SCAN][ITEM][START] step=${processedDiscoveryItems}/${Math.max(totalDiscoveryItems, 1)} path=${phaseItemLabel}`);
        const shouldLogProgress =
          processedDiscoveryItems === 1 ||
          processedDiscoveryItems === totalDiscoveryItems ||
          (processedDiscoveryItems % 25 === 0);
        setBatchScanStatus(
          {
            phase: 'discovery',
            message: `Procesando ${phaseItemLabel} · FS: leyendo contenido de carpeta`,
            current: processedDiscoveryItems,
            total: Math.max(totalDiscoveryItems, 1),
            counters: {
              folders: { done: folderIdx, total: folderPlans.length },
              items: { done: processedDiscoveryItems, total: totalDiscoveryItems },
              archives: { done: archivesDone, total: topArchives.length },
            },
          },
          { log: shouldLogProgress }
        );

        const assetPath = path.join(batchPath, assetFolder);
        const stats = collectFolderStats(assetPath);
        const statsMB = Number((Number(stats.totalBytes || 0) / (1024 * 1024)).toFixed(2));
        console.info(`[BATCH SCAN][ITEM][STATS] path=${phaseItemLabel} files=${Number(stats.fileCount || 0)} sizeMB=${statsMB}`);
        const isEmptyAssetFolder = Number(stats.fileCount || 0) <= 0;

        // Create an item if it doesn't exist
        setBatchScanStatus(
          {
            phase: 'discovery',
            message: `Procesando ${phaseItemLabel} · DB: buscando item existente`,
            current: processedDiscoveryItems,
            total: Math.max(totalDiscoveryItems, 1),
            counters: {
              folders: { done: folderIdx, total: folderPlans.length },
              items: { done: processedDiscoveryItems, total: totalDiscoveryItems },
              archives: { done: archivesDone, total: topArchives.length },
            },
          },
          { log: false }
        );
        const existingItem = await prisma.batchImportItem.findFirst({
          where: { batchId: batch.id, folderName: assetFolder }
        });

        if (isEmptyAssetFolder) {
          // Evitar basura en cola: carpeta vacía no se procesa.
          if (existingItem && ['DRAFT', 'FAILED', 'PENDING'].includes(String(existingItem.status || '').toUpperCase())) {
            setBatchScanStatus(
              {
                phase: 'discovery',
                message: `Procesando ${phaseItemLabel} · DB: eliminando item vacío id=${existingItem.id}`,
              },
              { log: false }
            );
            await prisma.batchImportItem.delete({ where: { id: existingItem.id } }).catch(() => {});
            console.info(`[BATCH SCAN][DB][DELETE_EMPTY] id=${existingItem.id} path=${phaseItemLabel}`);
          }

          if (assetFolder) {
            try { if (fs.existsSync(assetPath)) fs.rmSync(assetPath, { recursive: true, force: true }); } catch {}
          } else {
            removeDirIfEmpty(batchPath);
          }

          console.info(`[BATCH SCAN][ITEM][SKIP_EMPTY] path=${phaseItemLabel} ms=${Date.now() - itemStartedAt}`);
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
              description: String(existingItem.description || '').trim() || buildDefaultBilingualDescription(bilingualTitle.es, bilingualTitle.en, rawBaseTitle).es,
              descriptionEn: String(existingItem.descriptionEn || '').trim() || buildDefaultBilingualDescription(bilingualTitle.es, bilingualTitle.en, rawBaseTitle).en,
            };

            if (existingItem.status === 'FAILED') {
              updateData.status = 'DRAFT';
              updateData.error = null;
              updateData.mainStatus = 'PENDING';
              updateData.backupStatus = 'PENDING';
              updateData.mainProgress = 0;
            }

            setBatchScanStatus(
              {
                phase: 'discovery',
                message: `Procesando ${phaseItemLabel} · DB: actualizando item existente id=${existingItem.id}`,
              },
              { log: false }
            );
            await prisma.batchImportItem.update({
              where: { id: existingItem.id },
              data: updateData,
            });
            console.info(`[BATCH SCAN][ITEM][EXISTING_UPDATE] id=${existingItem.id} statusPrev=${existingItem.status} path=${phaseItemLabel}`);
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
          console.info(
            `[BATCH SCAN][ITEM][EXISTING] id=${existingItem.id} status=${existingItem.status} ` +
            `imgs=${Array.isArray(existingItem.images) ? existingItem.images.length : 0} sizeMB=${Number(existingItem.pesoMB || 0)} ` +
            `path=${phaseItemLabel} ms=${Date.now() - itemStartedAt}`
          );
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

          setBatchScanStatus(
            {
              phase: 'discovery',
              message: `Procesando ${phaseItemLabel} · DB: creando item nuevo`,
            },
            { log: false }
          );
          const createdItem = await prisma.batchImportItem.create({
            data: {
              batchId: batch.id,
              folderName: assetFolder, // Si es '', el worker apuntará directo al batchFolder
              title: bilingualTitle.es,
              titleEn: bilingualTitle.en,
              description: buildDefaultBilingualDescription(bilingualTitle.es, bilingualTitle.en, rawBaseTitle).es,
              descriptionEn: buildDefaultBilingualDescription(bilingualTitle.es, bilingualTitle.en, rawBaseTitle).en,
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
          console.info(
            `[BATCH SCAN][ITEM][NEW] id=${createdItem.id} title="${bilingualTitle.es}" ` +
            `imgs=${images.length} sizeMB=${pesoMB} path=${phaseItemLabel} ms=${Date.now() - itemStartedAt}`
          );
          newlyQueuedCount++;
        }
        itemsCount++;
      }

      await prisma.batchImport.update({
        where: { id: batch.id },
        data: { totalItems: itemsCount }
      });
      console.info(`[BATCH SCAN][DB][BATCH_TOTAL] batchId=${batch.id} folder=${folder} totalItems=${itemsCount}`);

      setBatchScanStatus(
        {
          phase: 'discovery',
          message: `Batch ${folder} completado (${folderIdx + 1}/${folderPlans.length})`,
          counters: {
            folders: { done: folderIdx + 1, total: folderPlans.length },
            items: { done: processedDiscoveryItems, total: totalDiscoveryItems },
            archives: { done: archivesDone, total: topArchives.length },
          },
        },
        { log: true }
      );
      console.info(`[BATCH SCAN][FOLDER][DONE] (${folderIdx + 1}/${folderPlans.length}) folder=${folder} items=${itemsCount} ms=${Date.now() - folderStartedAt}`);
    }

    console.info(`[BATCH SCAN][DISCOVERY] items detectados=${aiScannedItems.length} nuevos=${newlyQueuedCount}`);

    // Solo borramos comprimidos originales cuando TODO el scan terminó correctamente.
    setBatchScanStatus(
      {
        phase: 'cleanup',
        message: extractedArchivesThisRun.length > 0
          ? `Limpiando ${extractedArchivesThisRun.length} comprimido(s) originales...`
          : 'Sin comprimidos por limpiar.',
        current: 0,
        total: Math.max(extractedArchivesThisRun.length, 1),
        counters: {
          folders: { done: folderPlans.length, total: folderPlans.length },
          items: { done: processedDiscoveryItems, total: totalDiscoveryItems },
          archives: { done: archivesDone, total: topArchives.length },
        },
      },
      { log: true }
    );

    let deletedArchivesCount = 0;
    let cleanupProgress = 0;
    for (const extracted of extractedArchivesThisRun) {
      try {
        if (fs.existsSync(extracted.arcPath)) {
          fs.unlinkSync(extracted.arcPath);
          deletedArchivesCount += 1;
        }
      } catch (e) {
        console.warn(`[BATCH SCAN] Warn borrando comprimido ${extracted.archiveName}: ${e.message}`);
      }

      cleanupProgress += 1;
      const shouldLogCleanup = cleanupProgress === extractedArchivesThisRun.length || (cleanupProgress % 25 === 0);
      setBatchScanStatus(
        {
          phase: 'cleanup',
          message: `Limpieza de comprimidos ${cleanupProgress}/${extractedArchivesThisRun.length}`,
          current: cleanupProgress,
          total: Math.max(extractedArchivesThisRun.length, 1),
        },
        { log: shouldLogCleanup }
      );
    }

    console.info(`[BATCH SCAN][DONE] nuevos=${newlyQueuedCount} comprimidos-borrados=${deletedArchivesCount}/${extractedArchivesThisRun.length} itemsDetectados=${aiScannedItems.length}`);

    completeBatchScanStatus({
      message: `Escaneo completado: detectados=${aiScannedItems.length}, nuevos=${newlyQueuedCount}`,
      current: 1,
      total: 1,
      percent: 100,
      counters: {
        archives: { done: archivesDone, total: topArchives.length },
        folders: { done: folderPlans.length, total: folderPlans.length },
        items: { done: processedDiscoveryItems, total: totalDiscoveryItems },
      },
      result: {
        newlyQueuedCount,
        scannedItemsCount: aiScannedItems.length,
        deletedArchivesCount,
        processedArchivesCount: extractedArchivesThisRun.length,
      },
    });

    return res.json({
      success: true,
      message: `Escaneo completado. Se detectaron ${aiScannedItems.length} item(s) y se encolaron ${newlyQueuedCount} nuevos.`,
      newlyQueuedCount,
      scannedItemsCount: aiScannedItems.length,
      deletedArchivesCount,
      processedArchivesCount: extractedArchivesThisRun.length,
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
    try {
      const stackHead = String(error?.stack || '').split('\n').slice(0, 8).join(' | ');
      if (stackHead) console.error('[BATCH IMPORT SCAN ERROR][STACK]', stackHead);
    } catch {}
    completeBatchScanStatus(
      {
        message: `Escaneo falló: ${error?.message || error}`,
        error: String(error?.message || error),
      },
      'error'
    );
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  } finally {
    stopScanWatchdog();
  }
};

// GET /api/batch-imports/scan-status
export const getScanStatus = async (_req, res) => {
  return res.json({ success: true, scan: batchScanStatus });
};

// GET /api/batch-imports
export const getBatchQueue = async (req, res) => {
  try {
    const limitRaw = Number(req?.query?.limit);
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : undefined;
    const queue = await prisma.batchImportItem.findMany({
      include: {
        batch: true
      },
      orderBy: { createdAt: 'desc' },
      ...(take ? { take } : {})
    });
    return res.json({ success: true, items: queue });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/batch-imports/retry-ai
export const retryBatchAiFailedItems = async (req, res) => {
  try {
    const rawIds = Array.isArray(req?.body?.itemIds) ? req.body.itemIds : [];
    const requestedIds = Array.from(new Set(rawIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)));
    if (!requestedIds.length) {
      return res.status(400).json({ success: false, message: 'itemIds requerido' });
    }

    const items = await prisma.batchImportItem.findMany({
      where: { id: { in: requestedIds } },
      include: { batch: { select: { folderName: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const targets = items.filter((item) => ['DRAFT', 'FAILED', 'PENDING'].includes(String(item?.status || '').toUpperCase()));
    if (!targets.length) {
      return res.json({
        success: true,
        message: 'No hay items elegibles para reintento de IA.',
        requestedCount: requestedIds.length,
        targetCount: 0,
        apply: { applied: 0, skipped: 0, failed: 0, total: 0 },
        aiStats: null,
        aiFailedItems: 0,
        aiRateLimitedItems: 0,
        aiRetryAttempts: 0,
        aiFailedItemIds: [],
      });
    }

    const aiScannedItems = targets.map(buildAiScanItemFromBatchItem);
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
      foldersCount: 0,
      newlyQueuedCount: 0,
      scannedItems: aiScannedItems,
    }, {
      categories: categoriesCatalog,
      tags: tagsCatalog,
    });

    const rawTimeout = Number(process.env.BATCH_RETRY_AI_TIMEOUT_MS || 0);
    const aiTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 0;

    const aiPromise = callGoogleBatchScan(aiPayload);
    let aiTimedOut = false;
    let aiApplyDeferred = false;
    let aiStats = null;
    let apply = { applied: 0, skipped: 0, failed: 0, total: 0 };

    if (aiTimeoutMs > 0) {
      try {
        const aiResultRaw = await withTimeout(aiPromise, aiTimeoutMs, 'BATCH_AI_RETRY_TIMEOUT');
        const { suggestions, stats } = unpackAiScanResult(aiResultRaw);
        if (stats) aiStats = stats;
        apply = await applyAiSuggestionsToBatchItems(suggestions, { source: 'manual-retry-ai' });
      } catch (aiErr) {
        aiTimedOut = String(aiErr?.code || aiErr?.message || '').includes('BATCH_AI_RETRY_TIMEOUT');
        if (aiTimedOut) {
          aiApplyDeferred = true;
          aiPromise
            .then((lateRaw) => {
              const { suggestions, stats } = unpackAiScanResult(lateRaw);
              if (stats) {
                console.info('[BATCH][AI][RETRY_DEFERRED][STATS]', {
                  failedItems: Number(stats.failedItems || 0),
                  rateLimitedItems: Number(stats.rateLimitedItems || 0),
                  retryAttempts: Number(stats.retryAttempts || 0),
                });
              }
              return applyAiSuggestionsToBatchItems(suggestions, { source: 'manual-retry-ai-deferred' });
            })
            .catch((lateErr) => {
              console.error('[BATCH][AI][RETRY_DEFERRED][ERROR]', lateErr?.message || lateErr);
            });
        } else {
          throw aiErr;
        }
      }
    } else {
      const aiResultRaw = await aiPromise;
      const { suggestions, stats } = unpackAiScanResult(aiResultRaw);
      if (stats) aiStats = stats;
      apply = await applyAiSuggestionsToBatchItems(suggestions, { source: 'manual-retry-ai' });
    }

    return res.json({
      success: true,
      message: aiTimedOut
        ? 'Reintento IA en progreso diferido por timeout.'
        : `Reintento IA completado sobre ${targets.length} item(s).`,
      requestedCount: requestedIds.length,
      targetCount: targets.length,
      aiTimedOut,
      aiApplyDeferred,
      apply,
      aiStats,
      aiFailedItems: Number(aiStats?.failedItems || 0),
      aiRateLimitedItems: Number(aiStats?.rateLimitedItems || 0),
      aiRetryAttempts: Number(aiStats?.retryAttempts || 0),
      aiFailedItemIds: Array.isArray(aiStats?.failedItemIds) ? aiStats.failedItemIds : [],
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/batch-imports/items/:id  — Actualizar campos de un item
export const updateBatchItem = async (req, res) => {
  try {
    const { id } = req.params;
    const itemId = Number(id);
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ success: false, message: 'id invalido' });
    }

    const { targetAccount, title, titleEn, description, descriptionEn, tags, categories, similarityApproved } = req.body;

    const current = await prisma.batchImportItem.findUnique({
      where: { id: itemId },
      select: { id: true, status: true, title: true, titleEn: true, folderName: true },
    });

    if (!current) {
      return res.status(404).json({ success: false, message: 'Item no encontrado' });
    }

    const data = {};
    if (targetAccount !== undefined) data.targetAccount = Number(targetAccount) || null;

    const hasIncomingTitle = title !== undefined || titleEn !== undefined;
    if (hasIncomingTitle) {
      const statusNow = String(current.status || '').toUpperCase();
      const shouldEnsureUnique = ['DRAFT', 'FAILED', 'PENDING', 'QUEUED'].includes(statusNow);
      const requestedBase = String(
        title !== undefined
          ? title
          : (titleEn !== undefined ? titleEn : (current.title || current.folderName || 'Asset'))
      ).trim();

      if (shouldEnsureUnique) {
        const reservedKeys = await buildReservedBatchTitleSet([itemId]);
        const uniqueEs = await ensureUniqueBatchTitle(requestedBase, reservedKeys);
        const pair = normalizeBilingualTitlePair(uniqueEs, String(titleEn ?? current.titleEn ?? uniqueEs).trim(), uniqueEs);
        data.title = pair.es;
        data.titleEn = pair.en;
      } else {
        if (title !== undefined) data.title = title;
        if (titleEn !== undefined) data.titleEn = titleEn;
      }
    }

    if (description !== undefined) data.description = String(description || '').trim() || null;
    if (descriptionEn !== undefined) data.descriptionEn = String(descriptionEn || '').trim() || null;
    if (tags !== undefined) data.tags = normalizeBatchTags(tags, 3);
    if (categories !== undefined) data.categories = categories;
    if (similarityApproved !== undefined) data.similarityApproved = !!similarityApproved;

    const updated = await prisma.batchImportItem.update({
      where: { id: itemId },
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

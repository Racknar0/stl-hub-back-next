import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { decryptToJson } from '../utils/cryptoUtils.js';
import jwt from 'jsonwebtoken';
import { withMegaLock } from '../utils/megaQueue.js';
import { startUploadsActive } from '../utils/uploadsActiveFlag.js';
import { checkMegaLinkAlive } from '../utils/megaCheckFiles/megaLinkChecker.js';
import { maybeCheckMegaOnVisit } from '../utils/megaCheckFiles/visitTriggeredMegaCheck.js';
import { applyMegaProxy, listMegaProxies } from '../utils/megaProxy.js';
import { createPartFromBase64, GoogleGenAI, PartMediaResolutionLevel } from '@google/genai';
import qdrantService from '../services/qdrant.service.js';

const prisma = new PrismaClient();
import { randomizeFreebies, getRandomizeFreebiesCountFromEnv } from '../utils/randomizeFreebies.js';

// Progreso en memoria por assetId (0..100)
const progressMap = new Map();
// Progreso de réplicas: key `${assetId}:${accountId}` -> 0..100
const replicaProgressMap = new Map();

// Batch en memoria por MAIN accountId: agrupa assets para minimizar mega-login/logout.
// Nota: MEGAcmd es global, así que esto opera dentro del withMegaLock.
// Estado (best-effort, sólo para UI):
// { pending:Set<number>, running:boolean, phase:'main'|'backup'|null, mainQueue:number[], mainIndex:number,
//   backupQueue:number[], backupIndex:number, currentAssetId:number|null,
//   currentReplicaAssetId:number|null, currentBackupAccountId:number|null }
const megaBatchByMain = new Map();

// Hold de quiet del batch (por cuenta MAIN): mientras esté activo, NO se pasa a backups.
// Objetivo: permitir gaps largos (SCP lento) sin arrancar backups entre archivos.
const megaBatchQuietHolds = globalThis.__megaBatchQuietHolds || new Map();
globalThis.__megaBatchQuietHolds = megaBatchQuietHolds;

const assetHashBackfillState =
    globalThis.__assetHashBackfillState || {
        running: false,
        startedAt: null,
        finishedAt: null,
        lastError: null,
        totalAssets: 0,
        processedAssets: 0,
        totalImages: 0,
        processedImages: 0,
        hashedRows: 0,
        failedImages: 0,
        currentAssetId: null,
    };
globalThis.__assetHashBackfillState = assetHashBackfillState;

const ASSET_META_AI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const ASSET_DESCRIPTION_FALLBACK = 'No hay descripción de este producto.';
const ASSET_DESCRIPTION_EN_FALLBACK = 'No description available for this product.';
const ASSET_META_MAX_IMAGES_PER_ITEM = Math.max(1, Math.min(4, Number(process.env.ASSET_META_MAX_IMAGES_PER_ITEM) || 1));
const ASSET_META_MAX_IMAGE_BYTES = Math.max(256 * 1024, (Number(process.env.ASSET_META_MAX_IMAGE_MB) || 4) * 1024 * 1024);
const ASSET_META_MEDIA_RESOLUTION_RAW = String(process.env.ASSET_META_MEDIA_RESOLUTION || 'low').trim().toLowerCase();

function resolveMetaMediaResolution(raw) {
    if (raw === 'high') return PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;
    if (raw === 'medium') return PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM;
    return PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW;
}

const ASSET_META_MEDIA_RESOLUTION_LEVEL = resolveMetaMediaResolution(ASSET_META_MEDIA_RESOLUTION_RAW);
const IMAGE_MIME_BY_EXT = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

function isMegaBatchQuietHoldActive(mainAccountId) {
    try {
        const id = Number(mainAccountId);
        if (!Number.isFinite(id)) return false;
        const entry = megaBatchQuietHolds.get(id);
        if (!entry) return false;
        const untilMs = Number(entry.untilMs || 0);
        return Number.isFinite(untilMs) && untilMs > Date.now();
    } catch {
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoginAccessDeniedError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('access denied') || msg.includes('failed to login');
}

function isNotLoggedInError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('not logged in') || msg.includes('exited 57') || msg.includes('no active session');
}

function isMegaPutStallError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('mega_put_stall_timeout') || msg.includes('stall timeout') || msg.includes('no progress for');
}

function rotateArray(arr, offset = 0) {
    const a = Array.isArray(arr) ? arr : [];
    if (!a.length) return [];
    const n = ((Number(offset) || 0) % a.length + a.length) % a.length;
    if (!n) return a.slice();
    return a.slice(n).concat(a.slice(0, n));
}

async function megaLoginWithProxyRotationOrThrow(role, payload, proxies, ctx, { maxTries = 10 } = {}) {
    const list = Array.isArray(proxies) ? proxies : [];
    if (!list.length) throw new Error(`[BATCH] Sin proxies válidos para ${role}. (requisito: nunca IP directa) ${ctx}`);

    const tries = Math.min(Math.max(1, Number(maxTries) || 1), list.length);
    let lastErr = '';
    for (let i = 0; i < tries; i++) {
        const p = list[i];
        try {
            console.log(`[BATCH][${role}] Proxy try ${i + 1}/${tries} -> ${p?.proxyUrl || '--'} ${ctx}`);
            await applyProxyOrThrow(role, p, ctx);
            await megaLogoutBestEffort(`PREV ${ctx}`);
            await megaLoginOrThrow(payload, ctx);
            return p;
        } catch (e) {
            lastErr = e?.message || String(e);
            // si el login falla por proxy/account, probamos siguiente proxy
            continue;
        }
    }
    throw new Error(`[BATCH] No se pudo loguear en ${role} por proxies (tries=${tries}). lastErr=${String(lastErr).slice(0, 200)} ${ctx}`);
}

function getBatchInfoForAsset(assetId, mainAccountId) {
    const st = megaBatchByMain.get(Number(mainAccountId));
    if (!st) return null;

    const safeArr = (a) => (Array.isArray(a) ? a : []);
    const pendingArr = st.pending ? Array.from(st.pending) : [];
    const mainQueue = safeArr(st.mainQueue);
    const backupQueue = safeArr(st.backupQueue);

    const isInPending = pendingArr.includes(assetId);
    const isInMainQueue = mainQueue.includes(assetId);
    const isInBackupQueue = backupQueue.includes(assetId);

    let stage = 'idle';
    let position = null;
    let total = null;

    if (st.running) {
        if (st.phase === 'main') {
            if (st.currentAssetId === assetId) {
                stage = 'main-uploading';
                position = (Number(st.mainIndex) || 0) + 1;
                total = mainQueue.length || null;
            } else if (isInMainQueue) {
                stage = 'main-queued';
                position = mainQueue.indexOf(assetId) + 1;
                total = mainQueue.length;
            } else if (isInPending) {
                stage = 'main-queued';
                position = pendingArr.indexOf(assetId) + 1;
                total = pendingArr.length;
            }
        } else if (st.phase === 'backup') {
            if (st.currentReplicaAssetId === assetId) {
                stage = 'backup-uploading';
                position = (Number(st.backupIndex) || 0) + 1;
                total = backupQueue.length || null;
            } else if (isInBackupQueue) {
                stage = 'backup-queued';
                position = backupQueue.indexOf(assetId) + 1;
                total = backupQueue.length;
            } else if (isInPending) {
                stage = 'main-queued';
                position = pendingArr.indexOf(assetId) + 1;
                total = pendingArr.length;
            }
        } else if (isInPending) {
            stage = 'main-queued';
            position = pendingArr.indexOf(assetId) + 1;
            total = pendingArr.length;
        }
    } else if (isInPending) {
        stage = 'main-queued';
        position = pendingArr.indexOf(assetId) + 1;
        total = pendingArr.length;
    }

    return {
        mode: 'batch',
        mainAccountId: Number(mainAccountId),
        running: !!st.running,
        phase: st.phase || null,
        currentAssetId: st.currentAssetId ?? null,
        currentReplicaAssetId: st.currentReplicaAssetId ?? null,
        currentBackupAccountId: st.currentBackupAccountId ?? null,
        asset: { id: assetId, stage, position, total },
    };
}

const UPLOADS_DIR = path.resolve('uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const BATCH_IMPORTS_DIR = path.join(UPLOADS_DIR, 'batch_imports');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const ARCHIVES_DIR = path.join(UPLOADS_DIR, 'archives');
const SYNC_CACHE_DIR = path.join(UPLOADS_DIR, 'sync-cache');

function purgeDirContents(dir) {
    try {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir);
        for (const name of entries) {
            const p = path.join(dir, name);
            try {
                const st = fs.statSync(p);
                if (st.isDirectory())
                    fs.rmSync(p, { recursive: true, force: true });
                else fs.unlinkSync(p);
            } catch (e) {
                console.warn('[CLEANUP] purge warn:', e.message);
            }
        }
    } catch (e) {
        console.warn('[CLEANUP] purge root warn:', e.message);
    }
}

function preUploadCleanup() {
    // Limpieza segura: no vaciar completamente tmp para no borrar archivos en staging (SCP)
    // En su lugar, eliminar solo temporales antiguos y omitir carpetas de staging (por ejemplo, batch_*)
    try {
        const hours = Number(process.env.TEMP_CLEAN_MAX_AGE_HOURS || 48);
        cleanTempDirRecursive(hours * 60 * 60 * 1000);
    } catch (e) {
        console.warn('[CLEANUP] preUploadCleanup temp warn:', e.message);
    }
    // sync-cache puede purgarse completamente sin riesgo
    purgeDirContents(SYNC_CACHE_DIR);
}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function truncateBatchNotification(text, max = 0) {
    const s = String(text || '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const limit = Number(max);
    if (!Number.isFinite(limit) || limit <= 0) return s;
    if (s.length <= limit) return s;
    return `${s.slice(0, Math.max(0, limit - 1))}…`;
}

async function notifyBatchUploadFailure({
    phase,
    mainAccountId,
    assetId,
    backupAccountId,
    error,
    extra,
}) {
    try {
        const title = truncateBatchNotification(
            `[BATCH][${String(phase || 'UNKNOWN').toUpperCase()}] fallo de subida`
        , 120);

        const body = truncateBatchNotification(
            `main=${mainAccountId || '-'} asset=${assetId || '-'} backup=${backupAccountId || '-'} err=${String(error || 'unknown').slice(0, 220)}${extra ? ` | ${extra}` : ''}`
        );

        await prisma.notification.create({
            data: {
                title,
                body,
                status: 'UNREAD',
                type: 'AUTOMATION',
                typeStatus: 'ERROR',
            },
        });
    } catch (notifyErr) {
        console.warn('[BATCH][NOTIF][WARN] failed creating upload-failure notification:', notifyErr?.message || notifyErr);
    }
}

function safeName(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

function normalizeSignatureForStore(signature) {
    return String(signature || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 240);
}

function normalizePairForStore(assetAId, assetBId) {
    const a = Number(assetAId);
    const b = Number(assetBId);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0)
        return null;
    if (a === b) return null;
    return a < b ? { assetAId: a, assetBId: b } : { assetAId: b, assetBId: a };
}

function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v || '').trim()).filter(Boolean);
}

function getSafeUploadAbsolutePath(relPath) {
    const rel = String(relPath || '').replace(/^[/\\]+/, '');
    if (!rel) return null;
    const abs = path.resolve(path.join(UPLOADS_DIR, rel));
    const root = path.resolve(UPLOADS_DIR) + path.sep;
    if (!abs.startsWith(root)) return null;
    return abs;
}

async function computeAHashFromImagePath(absPath) {
    const { data, info } = await sharp(absPath)
        .rotate()
        .flatten({ background: '#ffffff' })
        .grayscale()
        .resize(8, 8, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

    if (!data || !data.length) throw new Error('Imagen vacía para hash');

    let sum = 0;
    for (const b of data) sum += Number(b || 0);
    const avg = sum / data.length;

    let bits = '';
    for (const b of data) bits += Number(b || 0) >= avg ? '1' : '0';

    const safeBits = bits.slice(0, 64).padEnd(64, '0');
    const hex = BigInt(`0b${safeBits}`).toString(16).padStart(16, '0');
    return {
        hashBits: safeBits,
        hashHex: hex,
        hashPrefix: hex.slice(0, 8),
        imageWidth: Number(info?.width || 0) || null,
        imageHeight: Number(info?.height || 0) || null,
    };
}

function isPrismaMissingTableError(err) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '').toLowerCase();
    return (
        code === 'P2021' ||
        msg.includes('does not exist') ||
        msg.includes('unknown table')
    );
}

async function syncAssetImageHashes(assetId, imagePaths = [], { clearMissing = true } = {}) {
    const id = Number(assetId);
    if (!Number.isFinite(id) || id <= 0) return { hashed: 0, failed: 0 };

    const paths = toStringArray(imagePaths);
    if (clearMissing) {
        if (paths.length) {
            await prisma.assetImageHash.deleteMany({
                where: {
                    assetId: id,
                    imagePath: { notIn: paths },
                },
            });
        } else {
            await prisma.assetImageHash.deleteMany({ where: { assetId: id } });
        }
    }

    let hashed = 0;
    let failed = 0;
    for (let i = 0; i < paths.length; i += 1) {
        const imagePath = paths[i];
        try {
            const absPath = getSafeUploadAbsolutePath(imagePath);
            if (!absPath || !fs.existsSync(absPath)) {
                failed += 1;
                continue;
            }

            const h = await computeAHashFromImagePath(absPath);
            await prisma.assetImageHash.upsert({
                where: { assetId_imagePath: { assetId: id, imagePath } },
                create: {
                    assetId: id,
                    imagePath,
                    imageIndex: i,
                    hashBits: h.hashBits,
                    hashHex: h.hashHex,
                    hashPrefix: h.hashPrefix,
                    hashAlgo: 'ahash-v1',
                    hashVersion: 1,
                    imageWidth: h.imageWidth,
                    imageHeight: h.imageHeight,
                },
                update: {
                    imageIndex: i,
                    hashBits: h.hashBits,
                    hashHex: h.hashHex,
                    hashPrefix: h.hashPrefix,
                    hashAlgo: 'ahash-v1',
                    hashVersion: 1,
                    imageWidth: h.imageWidth,
                    imageHeight: h.imageHeight,
                },
            });
            hashed += 1;
        } catch (e) {
            failed += 1;
            console.warn(
                `[ASSETS][HASH] warn asset=${id} image=${imagePath}:`,
                e?.message || String(e)
            );
        }
    }
    return { hashed, failed };
}

async function runAssetImageHashBackfill({ batchSize = 100 } = {}) {
    if (assetHashBackfillState.running) return;

    assetHashBackfillState.running = true;
    assetHashBackfillState.startedAt = new Date().toISOString();
    assetHashBackfillState.finishedAt = null;
    assetHashBackfillState.lastError = null;
    assetHashBackfillState.totalAssets = 0;
    assetHashBackfillState.processedAssets = 0;
    assetHashBackfillState.totalImages = 0;
    assetHashBackfillState.processedImages = 0;
    assetHashBackfillState.hashedRows = 0;
    assetHashBackfillState.failedImages = 0;
    assetHashBackfillState.currentAssetId = null;

    try {
        const take = Math.max(10, Math.min(500, Number(batchSize) || 100));
        const totalAssets = await prisma.asset.count();
        assetHashBackfillState.totalAssets = Number(totalAssets || 0);

        let cursorId = 0;
        while (true) {
            const page = await prisma.asset.findMany({
                where: cursorId > 0 ? { id: { gt: cursorId } } : undefined,
                select: { id: true, images: true },
                orderBy: { id: 'asc' },
                take,
            });
            if (!page.length) break;

            for (const item of page) {
                assetHashBackfillState.currentAssetId = item.id;
                const images = toStringArray(item?.images || []);
                assetHashBackfillState.totalImages += images.length;

                try {
                    const r = await syncAssetImageHashes(item.id, images, {
                        clearMissing: true,
                    });
                    assetHashBackfillState.hashedRows += Number(r?.hashed || 0);
                    assetHashBackfillState.failedImages += Number(
                        r?.failed || 0
                    );
                } catch (e) {
                    assetHashBackfillState.failedImages += images.length;
                    console.warn(
                        `[ASSETS][HASH][BACKFILL] warn asset=${item.id}:`,
                        e?.message || String(e)
                    );
                }

                assetHashBackfillState.processedAssets += 1;
                assetHashBackfillState.processedImages += images.length;
            }

            cursorId = page[page.length - 1].id;
        }
    } catch (e) {
        assetHashBackfillState.lastError = e?.message || String(e);
        console.error('[ASSETS][HASH][BACKFILL] error:', e);
    } finally {
        assetHashBackfillState.currentAssetId = null;
        assetHashBackfillState.running = false;
        assetHashBackfillState.finishedAt = new Date().toISOString();
    }
}


function safeFileName(originalName) {
    const ext = path.extname(originalName) || '';
    const base =
        path
            .basename(originalName, ext)
            .replace(/[^a-zA-Z0-9-_]+/g, '_')
            .slice(0, 120) || 'file';
    return `${base}${ext}`;
}
// Limpieza de archivos temporales antiguos en uploads/tmp
function cleanTempDir(maxAgeMs = 20 * 60 * 1000) {
    try {
        const now = Date.now();
        if (!fs.existsSync(TEMP_DIR)) return;
        const names = fs.readdirSync(TEMP_DIR);
        for (const name of names) {
            const p = path.join(TEMP_DIR, name);
            try {
                const st = fs.statSync(p);
                if (st.isFile()) {
                    const age = now - st.mtimeMs;
                    if (age > maxAgeMs) {
                        fs.unlinkSync(p);
                    }
                }
            } catch (e) {
                // continuar
            }
        }
    } catch (e) {
        console.warn('[CLEANUP] temp dir cleanup warn:', e.message);
    }
}

// Limpieza recursiva de uploads/tmp por antigüedad.
// - No borra directorios de staging que coincidan con skipDirRegex (por defecto /^batch_/)
// - Elimina archivos con mtime más antiguo que maxAgeMs en subcarpetas permitidas
// - Intenta eliminar directorios vacíos tras la limpieza
function cleanTempDirRecursive(maxAgeMs = 48 * 60 * 60 * 1000, { skipDirRegex = /^batch_/ } = {}) {
    try {
        const now = Date.now();
        const walk = (dir) => {
            if (!fs.existsSync(dir)) return;
            const entries = fs.readdirSync(dir);
            for (const name of entries) {
                const p = path.join(dir, name);
                try {
                    const st = fs.statSync(p);
                    if (st.isDirectory()) {
                        if (skipDirRegex && skipDirRegex.test(name)) {
                            // No entrar en carpetas de staging activas
                            continue;
                        }
                        walk(p);
                        // Intentar borrar si quedó vacía
                        try {
                            const items = fs.readdirSync(p);
                            if (items.length === 0) fs.rmdirSync(p);
                        } catch {}
                    } else if (st.isFile()) {
                        const age = now - Number(st.mtimeMs);
                        if (age > maxAgeMs) {
                            try { fs.unlinkSync(p); } catch {}
                        }
                    }
                } catch {}
            }
        };
        walk(TEMP_DIR);
    } catch (e) {
        console.warn('[CLEANUP] recursive temp cleanup warn:', e.message);
    }
}
function removeEmptyDirsUp(startDir, stopDir) {
    try {
        let dir = path.resolve(startDir);
        const stop = path.resolve(stopDir);
        while (dir.startsWith(stop)) {
            if (!fs.existsSync(dir)) {
                dir = path.dirname(dir);
                continue;
            }
            const items = fs.readdirSync(dir);
            if (items.length === 0) {
                fs.rmdirSync(dir);
                if (dir === stop) break;
                dir = path.dirname(dir);
            } else {
                break;
            }
        }
    } catch (e) {
        console.warn('[CLEANUP] removeEmptyDirsUp warn:', e.message);
    }
}

function envFlag(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw == null) return !!defaultValue;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    return !!defaultValue;
}

async function deleteLocalArchiveIfEligible(assetId, { requiredBackupAccountIds = [], ctx = '' } = {}) {
    try {
        // Por defecto: borrar el archivo local cuando termine MAIN + BACKUPs.
        // Se puede desactivar seteando MEGA_DELETE_LOCAL_ARCHIVE_AFTER_UPLOAD=false
        if (!envFlag('MEGA_DELETE_LOCAL_ARCHIVE_AFTER_UPLOAD', true)) return;

        const a = await prisma.asset.findUnique({
            where: { id: Number(assetId) },
            select: { id: true, status: true, archiveName: true },
        });
        if (!a?.archiveName) return;
        if (a.status !== 'PUBLISHED') return;

        const required = (requiredBackupAccountIds || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
        if (required.length) {
            const reps = await prisma.assetReplica.findMany({
                where: { assetId: a.id, accountId: { in: required } },
                select: { accountId: true, status: true },
            });
            const byAcc = new Map(reps.map((r) => [Number(r.accountId), r.status]));
            const allCompleted = required.every((accId) => byAcc.get(accId) === 'COMPLETED');
            if (!allCompleted) return;
        }

        const rel = String(a.archiveName || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const relWithArchives = rel.startsWith('archives/') ? rel : `archives/${rel}`;
        const abs = path.resolve(path.join(UPLOADS_DIR, relWithArchives));
        const root = path.resolve(ARCHIVES_DIR) + path.sep;
        if (!abs.startsWith(root)) {
            console.warn(`[BATCH][CLEANUP] skip delete (outside archives) asset=${a.id} abs=${abs}`);
            return;
        }
        if (!fs.existsSync(abs)) return;

        try {
            fs.unlinkSync(abs);
            removeEmptyDirsUp(path.dirname(abs), ARCHIVES_DIR);
            console.log(`[BATCH][CLEANUP] deleted local archive asset=${a.id} ${ctx}`);
        } catch (e) {
            console.warn(`[BATCH][CLEANUP] delete warn asset=${a.id} msg=${e.message} ${ctx}`);
        }
    } catch (e) {
        console.warn(`[BATCH][CLEANUP] error asset=${assetId} msg=${e.message} ${ctx}`);
    }
}

// helpers para parsear categorías múltiples (por id o slug)
function parseCategoriesPayload(val) {
    // admite: [1,2] o ["anime","cosplay"] o "anime,cosplay"
    if (!val) return [];
    let arr = [];
    if (Array.isArray(val)) arr = val;
    else {
        try {
            const j = JSON.parse(val);
            if (Array.isArray(j)) arr = j;
        } catch {
            arr = String(val).split(',');
        }
    }
    return arr
        .map((v) =>
            typeof v === 'number' ? { id: v } : { slug: safeName(String(v)) }
        )
        .filter(Boolean);
}

// Nueva: parseo para tags M:N por id o slug
function parseTagsPayload(val) {
    if (!val) return [];
    let arr = [];
    if (Array.isArray(val)) arr = val;
    else {
        try {
            const j = JSON.parse(val);
            if (Array.isArray(j)) arr = j;
        } catch {
            arr = String(val).split(',');
        }
    }
    return arr
        .map((v) =>
            typeof v === 'number' ? { id: v } : { slug: safeName(String(v)) }
        )
        .filter(Boolean);
}

function normalizeMetaText(value, maxLen = 380) {
    const txt = String(value || '').replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    if (txt.length <= maxLen) return txt;
    return `${txt.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

function normalizeDescriptionText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function toUploadsRelativeImagePath(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';

    if (/^https?:\/\//i.test(value)) {
        const marker = '/uploads/';
        const idx = value.toLowerCase().indexOf(marker);
        if (idx < 0) return '';
        value = value.slice(idx + marker.length);
    }

    value = value.replace(/\\/g, '/').replace(/^\/+/, '');
    if (value.toLowerCase().startsWith('uploads/')) {
        value = value.slice('uploads/'.length);
    }

    if (!value || value.includes('..')) return '';
    return value;
}

function collectAssetImageRelativePaths(asset) {
    const rawImages = Array.isArray(asset?.images) ? asset.images : [];
    const out = [];
    const seen = new Set();

    for (const entry of rawImages) {
        const candidate = typeof entry === 'string'
            ? entry
            : (entry?.path || entry?.src || entry?.url || entry?.image || '');
        const rel = toUploadsRelativeImagePath(candidate);
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        out.push(rel);
        if (out.length >= ASSET_META_MAX_IMAGES_PER_ITEM) break;
    }

    return out;
}

function getImageMimeType(filePath) {
    return IMAGE_MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] || null;
}

async function buildAssetImageParts(asset) {
    const relPaths = collectAssetImageRelativePaths(asset);
    const parts = [];
    let attachedImages = 0;

    for (const rel of relPaths) {
        const abs = path.join(UPLOADS_DIR, rel);
        const mimeType = getImageMimeType(abs);
        if (!mimeType || !fs.existsSync(abs)) continue;

        let stat = null;
        try {
            stat = fs.statSync(abs);
        } catch {
            stat = null;
        }
        if (!stat?.isFile() || stat.size <= 0 || stat.size > ASSET_META_MAX_IMAGE_BYTES) continue;

        try {
            const base64Data = fs.readFileSync(abs).toString('base64');
            parts.push(createPartFromBase64(base64Data, mimeType, ASSET_META_MEDIA_RESOLUTION_LEVEL));
            attachedImages += 1;
        } catch (err) {
            console.warn('[ASSETS][META][IMAGE_WARN]', rel, err?.message || err);
        }
    }

    return { parts, attachedImages };
}

async function updateAssetDescriptionSafely(assetId, rawDescription) {
    const numericAssetId = Number(assetId);
    const safe = normalizeDescriptionText(rawDescription) || ASSET_DESCRIPTION_FALLBACK;
    await prisma.asset.update({
        where: { id: numericAssetId },
        data: { description: safe },
    });
    qdrantService
        .upsertAssetVector(numericAssetId)
        .catch((err) => console.error('[QDRANT] Description update error:', err));
    return safe;
}

async function updateAssetDescriptionsSafely(assetId, rawDescriptionEs, rawDescriptionEn) {
    const numericAssetId = Number(assetId);
    const safeEs = normalizeDescriptionText(rawDescriptionEs) || ASSET_DESCRIPTION_FALLBACK;
    const safeEn = normalizeDescriptionText(rawDescriptionEn) || ASSET_DESCRIPTION_EN_FALLBACK;
    await prisma.asset.update({
        where: { id: numericAssetId },
        data: {
            description: safeEs,
            descriptionEn: safeEn,
        },
    });
    qdrantService
        .upsertAssetVector(numericAssetId)
        .catch((err) => console.error('[QDRANT] Description regenerate error:', err));
    return { description: safeEs, descriptionEn: safeEn };
}

function parseJsonLoose(rawText) {
    const txt = String(rawText || '').trim();
    if (!txt) return null;
    try {
        return JSON.parse(txt);
    } catch {}

    const fenced = txt.match(/```json\s*([\s\S]*?)```/i) || txt.match(/```\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {}
    }

    const firstBrace = txt.indexOf('{');
    const lastBrace = txt.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
            return JSON.parse(txt.slice(firstBrace, lastBrace + 1));
        } catch {}
    }

    const firstBracket = txt.indexOf('[');
    const lastBracket = txt.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) {
        try {
            return JSON.parse(txt.slice(firstBracket, lastBracket + 1));
        } catch {}
    }

    return null;
}

function buildAssetMetaInput(asset) {
    const categories = Array.isArray(asset?.categories)
        ? asset.categories.map((c) => ({
              id: c?.id,
              es: c?.name || '',
              en: c?.nameEn || c?.name || '',
              slug: c?.slug || '',
          }))
        : [];
    const tags = Array.isArray(asset?.tags)
        ? asset.tags.map((t) => ({
              id: t?.id,
              es: t?.name || t?.slug || '',
              en: t?.nameEn || t?.name || t?.slug || '',
              slug: t?.slug || '',
          }))
        : [];

    return {
        id: Number(asset?.id || 0) || null,
        titleEs: String(asset?.title || '').trim(),
        titleEn: String(asset?.titleEn || '').trim(),
        imageHints: collectAssetImageRelativePaths(asset),
        categories,
        tags,
        currentDescription: String(asset?.description || '').trim(),
        currentDescriptionEn: String(asset?.descriptionEn || '').trim(),
    };
}

function getGeminiClient() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({
        apiKey,
        httpOptions: {
            apiVersion: 'v1alpha',
        },
    });
}

async function generateSeoDescriptionForAsset(assetInput, assetRaw = null) {
    const fallback = {
        es: ASSET_DESCRIPTION_FALLBACK,
        en: ASSET_DESCRIPTION_EN_FALLBACK,
    };
    const ai = getGeminiClient();
    if (!ai) return fallback;

    const { parts: imageParts, attachedImages } = await buildAssetImageParts(assetRaw);

    const prompt = [
        'Eres redactor SEO para tienda de modelos STL.',
        'Genera descripción SEO bilingüe (ES + EN) de 80 a 150 palabras por idioma para ficha de producto.',
        'Debes analizar primero las imágenes adjuntas del asset (si existen).',
        'Si no hay imágenes suficientes, usa título/categorías/tags como respaldo.',
        'Reglas estrictas para cada idioma: 3 a 5 frases, sin emojis, sin markdown, texto natural y descriptivo.',
        'La descripcion debe describir visualmente el modelo basandose en las imagenes (pose, detalles, accesorios), indicar tipo de impresion recomendada (resina/FDM), sugerir uso (exhibicion, cosplay, decoracion) y mencionar nivel de detalle. NO inventar datos que no se observen en las imagenes. Ideal para SEO y posicionamiento en Google.',
        'Si falta contexto, escribe una descripción genérica breve y correcta.',
        'Responde SOLO JSON con forma: {"description":{"es":"...","en":"..."}}.',
        'Contexto:',
        JSON.stringify(assetInput, null, 2),
        `Imágenes adjuntas: ${attachedImages}`,
    ].join('\n\n');

    try {
        const response = await ai.models.generateContent({
            model: ASSET_META_AI_MODEL,
            contents: [prompt, ...imageParts],
            config: {
                responseMimeType: 'application/json',
                responseJsonSchema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['description'],
                    properties: {
                        description: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['es', 'en'],
                            properties: {
                                es: { type: 'string' },
                                en: { type: 'string' },
                            },
                        },
                    },
                },
            },
        });

        const parsed = parseJsonLoose(response?.text);
        const rawEs = typeof parsed?.description === 'object'
            ? parsed?.description?.es
            : parsed?.description;
        const rawEn = typeof parsed?.description === 'object'
            ? parsed?.description?.en
            : '';

        const descEs = normalizeDescriptionText(rawEs || '') || fallback.es;
        const descEn = normalizeDescriptionText(rawEn || '') || fallback.en;
        return {
            es: descEs,
            en: descEn,
        };
    } catch (err) {
        console.warn('[ASSETS][META][DESCRIPTION_AI_WARN]', err?.message || err);
        return fallback;
    }
}

function normalizeBilingualGeneratedTags(rawTags) {
    const arr = Array.isArray(rawTags) ? rawTags : [];
    const out = [];
    const seen = new Set();

    for (const item of arr) {
        const es = normalizeMetaText(item?.es || item?.name || '', 64).toLowerCase();
        const en = normalizeMetaText(item?.en || item?.nameEn || es || '', 64).toLowerCase();
        const key = safeName(en || es || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({
            es: es || en,
            en: en || es,
        });
        if (out.length >= 3) break;
    }

    return out;
}

async function generateSeoTagPairsForAsset(assetInput) {
    const ai = getGeminiClient();
    if (!ai) return [];

    const prompt = [
        'Eres especialista SEO para marketplace de modelos STL.',
        'Devuelve EXACTAMENTE 3 tags relevantes para posicionamiento y búsqueda interna.',
        'Cada tag debe ser corto (1 a 2 palabras) y bilingüe: { es, en }.',
        'Evita tags genéricos como stl, print, 3d, model.',
        'Responde SOLO JSON con esta forma: {"tags":[{"es":"...","en":"..."},{"es":"...","en":"..."},{"es":"...","en":"..."}]}.',
        'Contexto:',
        JSON.stringify(assetInput, null, 2),
    ].join('\n\n');

    try {
        const response = await ai.models.generateContent({
            model: ASSET_META_AI_MODEL,
            contents: [prompt],
            config: {
                responseMimeType: 'application/json',
                responseJsonSchema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['tags'],
                    properties: {
                        tags: {
                            type: 'array',
                            minItems: 3,
                            maxItems: 3,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['es', 'en'],
                                properties: {
                                    es: { type: 'string' },
                                    en: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        });

        const parsed = parseJsonLoose(response?.text);
        return normalizeBilingualGeneratedTags(parsed?.tags);
    } catch (err) {
        console.warn('[ASSETS][META][TAGS_AI_WARN]', err?.message || err);
        return [];
    }
}

async function ensureTagIdsFromPairs(tagPairs) {
    const ids = [];
    const seenIds = new Set();

    for (let i = 0; i < tagPairs.length; i += 1) {
        const pair = tagPairs[i] || {};
        const es = normalizeMetaText(pair.es || '', 64).toLowerCase();
        const en = normalizeMetaText(pair.en || es || '', 64).toLowerCase();
        const slug = safeName(en || es || `tag-${i + 1}`) || `tag-${Date.now()}-${i + 1}`;

        let found = await prisma.tag.findFirst({
            where: {
                OR: [
                    { slug },
                    { slugEn: slug },
                    ...(es ? [{ name: es }] : []),
                    ...(en ? [{ nameEn: en }] : []),
                ],
            },
            select: { id: true },
        });

        if (!found) {
            try {
                found = await prisma.tag.create({
                    data: {
                        name: es || en || slug,
                        nameEn: en || es || null,
                        slug,
                        slugEn: slug,
                    },
                    select: { id: true },
                });
            } catch (createErr) {
                if (createErr?.code === 'P2002') {
                    found = await prisma.tag.findFirst({
                        where: {
                            OR: [
                                { slug },
                                { slugEn: slug },
                                ...(es ? [{ name: es }] : []),
                                ...(en ? [{ nameEn: en }] : []),
                            ],
                        },
                        select: { id: true },
                    });
                } else {
                    throw createErr;
                }
            }
        }

        const id = Number(found?.id || 0);
        if (Number.isFinite(id) && id > 0 && !seenIds.has(id)) {
            seenIds.add(id);
            ids.push(id);
        }
    }

    return ids;
}

// Generar slug único (hasta maxTries variantes) evitando crear archivos/directorios basura con slug repetido
async function generateUniqueSlug(base, maxTries = 50) {
    const slugBase = base || 'asset';
    for (let i = 0; i < maxTries; i++) {
        const candidate = i === 0 ? slugBase : `${slugBase}-${i}`;
        const exists = await prisma.asset.findUnique({
            where: { slug: candidate },
            select: { id: true },
        });
        if (!exists) return candidate;
    }
    throw Object.assign(new Error('No unique slug available'), {
        code: 'SLUG_EXHAUSTED',
    });
}

// Helper: convierte BigInt a Number recursivamente para respuestas JSON seguras
function toJsonSafe(value) {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map((v) => toJsonSafe(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
        return out;
    }
    return value;
}

function stripExtension(filename) {
    const s = String(filename || '').trim();
    if (!s) return '';
    return s.replace(/\.[^./\\]+$/, '');
}

function normalizeForCompare(s) {
    return normalizeSpacedText(s).replace(/\s+/g, '').trim();
}

function normalizeSpacedText(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/([a-z])([0-9])/gi, '$1 $2')
        .replace(/([0-9])([a-z])/gi, '$1 $2')
        .toLowerCase()
        .replace(/[_\-\.]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqueStrings(arr) {
    const out = [];
    const seen = new Set();
    for (const v of arr || []) {
        const s = String(v || '').trim();
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

function stripDigitsKeepLetters(s) {
    return String(s || '').replace(/\d+/g, '').trim();
}

const SIMILAR_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'sin', 'con', 'para', 'stl', 'model', 'modelo',
    'file', 'archivo', 'version', 'ver', 'final', 'new', 'nuevo', 'pack', 'set',
]);

function canonicalToken(t) {
    let x = normalizeSpacedText(t);
    if (!x) return '';
    // singularizar simple para reducir ruido (models -> model, piezas -> pieza)
    if (x.length > 4 && x.endsWith('es')) x = x.slice(0, -2);
    else if (x.length > 3 && x.endsWith('s')) x = x.slice(0, -1);
    return x;
}

function toMeaningfulTokens(input, { minLen = 3, includePrefixes = true } = {}) {
    const raw = normalizeSpacedText(input)
        .split(/\s+/g)
        .map((t) => t.trim())
        .filter(Boolean);

    const out = [];
    for (const tok of raw) {
        const base = canonicalToken(tok);
        const noDigits = canonicalToken(stripDigitsKeepLetters(base));
        const cand = uniqueStrings([tok, base, noDigits]);
        for (const c of cand) {
            if (!c || c.length < minLen) continue;
            if (SIMILAR_STOPWORDS.has(c)) continue;
            out.push(c);
            if (includePrefixes && c.length >= 6) out.push(c.slice(0, 5));
        }
    }
    return uniqueStrings(out);
}

function extractLastSegment(value) {
    const txt = String(value || '').trim();
    const parts = txt.split(/[\\/]+/g).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : txt;
}

function buildTrigramSet(compact) {
    const s = String(compact || '').trim();
    if (!s) return new Set();
    if (s.length <= 3) return new Set([s]);
    const out = new Set();
    for (let i = 0; i <= s.length - 3; i += 1) {
        out.add(s.slice(i, i + 3));
    }
    return out;
}

function jaccardSimilarity(setA, setB) {
    if (!setA?.size || !setB?.size) return 0;
    let inter = 0;
    for (const it of setA) if (setB.has(it)) inter += 1;
    const union = setA.size + setB.size - inter;
    return union > 0 ? inter / union : 0;
}

function levenshteinRatio(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (!s || !t) return 0;
    if (s === t) return 1;

    const maxLen = Math.max(s.length, t.length);
    if (!maxLen) return 0;
    if (Math.abs(s.length - t.length) > Math.ceil(maxLen * 0.6)) return 0;

    const prev = new Array(t.length + 1);
    const curr = new Array(t.length + 1);

    for (let j = 0; j <= t.length; j += 1) prev[j] = j;

    for (let i = 1; i <= s.length; i += 1) {
        curr[0] = i;
        for (let j = 1; j <= t.length; j += 1) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost
            );
        }
        for (let j = 0; j <= t.length; j += 1) prev[j] = curr[j];
    }

    const dist = prev[t.length];
    return Math.max(0, 1 - dist / maxLen);
}

function tokenizeSimilarQuery(input) {
    const base = stripExtension(extractLastSegment(String(input || '').trim()));
    const baseNoDigits = String(base).replace(/\d+/g, ' ').trim();
    const baseNorm = normalizeForCompare(base);
    const baseNoDigitsNorm = normalizeForCompare(baseNoDigits);

    const strongTokens = toMeaningfulTokens(`${base} ${baseNoDigits}`, {
        minLen: 3,
        includePrefixes: true,
    }).slice(0, 18);

    const safeBase = safeName(base);
    const searchTerms = uniqueStrings([base, baseNoDigits, safeBase, ...strongTokens])
        .map((t) => String(t || '').trim())
        .filter((t) => t.length >= 2)
        .slice(0, 24);

    const queryTokenSet = new Set(strongTokens.map((t) => normalizeForCompare(t)).filter(Boolean));
    const queryTrigrams = buildTrigramSet(baseNorm);

    return {
        base,
        baseNorm,
        baseNoDigits,
        baseNoDigitsNorm,
        strongTokens,
        searchTerms,
        queryTokenSet,
        queryTrigrams,
        queryPhrase: normalizeSpacedText(base),
        queryCompact: normalizeForCompare(base),
    };
}

function tokenizeCandidateForScore(s) {
    const tokens = toMeaningfulTokens(s, { minLen: 3, includePrefixes: true });
    return new Set(tokens.map((t) => normalizeForCompare(t)).filter(Boolean));
}

function normalizeAHashHex(input) {
    const cleaned = String(input || '')
        .trim()
        .toLowerCase()
        .replace(/[^0-9a-f]/g, '');
    if (!cleaned) return '';
    if (cleaned.length >= 16) return cleaned.slice(0, 16);
    return cleaned.padStart(16, '0');
}

function uniqueAHashHexes(input, { max = 12 } = {}) {
    const arr = Array.isArray(input) ? input : [input];
    const out = [];
    const seen = new Set();
    for (const item of arr) {
        if (out.length >= max) break;
        const hex = normalizeAHashHex(item);
        if (!hex || hex.length !== 16) continue;
        if (seen.has(hex)) continue;
        seen.add(hex);
        out.push(hex);
    }
    return out;
}

function popcountBigInt(v) {
    let n = BigInt(v || 0);
    let c = 0;
    while (n > 0n) {
        n &= n - 1n;
        c += 1;
    }
    return c;
}

function hammingDistanceFromHex(aHex, bHex) {
    try {
        const a = BigInt(`0x${normalizeAHashHex(aHex)}`);
        const b = BigInt(`0x${normalizeAHashHex(bHex)}`);
        return popcountBigInt(a ^ b);
    } catch {
        return 64;
    }
}

function scoreImageHashSimilarity(queryHashes, candidateHashes) {
    const q = uniqueAHashHexes(queryHashes, { max: 12 });
    const c = uniqueAHashHexes(candidateHashes, { max: 48 });
    if (!q.length || !c.length) {
        return {
            score: 0,
            matchCount: 0,
            strongCount: 0,
            bestDistance: null,
            averageBestDistance: null,
        };
    }

    const bestDistances = q.map((qh) => {
        let best = 64;
        for (const ch of c) {
            const dist = hammingDistanceFromHex(qh, ch);
            if (dist < best) best = dist;
            if (best === 0) break;
        }
        return best;
    });

    const bestDistance = bestDistances.length ? Math.min(...bestDistances) : 64;
    const averageBestDistance =
        bestDistances.length > 0
            ? bestDistances.reduce((sum, d) => sum + d, 0) / bestDistances.length
            : 64;

    const matchCount = bestDistances.filter((d) => d <= 10).length;
    const strongCount = bestDistances.filter((d) => d <= 6).length;
    const coverage = matchCount / q.length;
    const strongCoverage = strongCount / q.length;

    let score = 0;
    score += Math.round(coverage * 120);
    score += Math.round(strongCoverage * 85);
    score += Math.max(0, Math.round((14 - averageBestDistance) * 5));
    if (bestDistance <= 4) score += 48;
    else if (bestDistance <= 6) score += 30;
    else if (bestDistance <= 8) score += 18;

    return {
        score,
        matchCount,
        strongCount,
        bestDistance,
        averageBestDistance: Number(averageBestDistance.toFixed(2)),
    };
}

function parseStringListInput(value, { max = 32 } = {}) {
    let arr = [];
    if (Array.isArray(value)) arr = value;
    else if (value !== undefined && value !== null) arr = String(value).split(',');

    return uniqueStrings(
        arr
            .map((v) => String(v || '').trim())
            .filter(Boolean)
    ).slice(0, max);
}

function parseNumberListInput(value, { max = 32 } = {}) {
    const raw = parseStringListInput(value, { max: max * 2 });
    const out = [];
    const seen = new Set();
    for (const it of raw) {
        if (out.length >= max) break;
        const n = Number(it);
        if (!Number.isFinite(n) || n <= 0) continue;
        const key = Math.trunc(n);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

// Listar y obtener
export const listAssets = async (req, res) => {
    try {
    const { q = '', pageIndex, pageSize, plan, isPremium, accountId, accountAlias, is_ai_search } = req.query;
        const hasPagination = pageIndex !== undefined && pageSize !== undefined;

        // Construir filtro dinámico
        const where = {};
        if (is_ai_search === 'true' && q) {
            const limit = pageSize ? Number(pageSize) : 50;
            const aiResults = await qdrantService.searchSimilarAssets(String(q), limit);
            const foundIds = aiResults.map(res => Number(res.id));
            if (foundIds.length > 0) {
                where.id = { in: foundIds };
            } else {
                where.id = -1; // Fuerza vacío
            }
        } else if (q) {
            const qStr = String(q);
            // Buscar tanto por título visible como por nombre de archivo (si existe en el modelo)
            where.OR = [
                { title: { contains: qStr } },
                { archiveName: { contains: qStr } },
            ];
        }
        // plan=free|premium o isPremium=true|false
        const planStr = String(plan || '').toLowerCase();
        if (planStr === 'free') where.isPremium = false;
        else if (planStr === 'premium') where.isPremium = true;

        if (
            isPremium !== undefined &&
            isPremium !== null &&
            String(isPremium).length
        ) {
            const b = String(isPremium).toLowerCase();
            if (b === 'true') where.isPremium = true;
            if (b === 'false') where.isPremium = false;
        }

        // Filtro por cuenta (ID directo o alias -> ID)
        let accIdFilter = null;
        if (accountId !== undefined && accountId !== null && String(accountId).length) {
            const asNum = Number(accountId);
            if (Number.isFinite(asNum) && asNum > 0) accIdFilter = asNum;
        } else if (accountAlias && String(accountAlias).trim().length) {
            try {
                const acc = await prisma.megaAccount.findFirst({ where: { alias: { contains: String(accountAlias).trim() } }, select: { id: true } });
                if (acc?.id) accIdFilter = acc.id;
            } catch {}
        }
        if (accIdFilter) where.accountId = accIdFilter;

        if (hasPagination) {
            const take = Math.max(1, Math.min(1000, Number(pageSize) || 50));
            const page = Math.max(0, Number(pageIndex) || 0);
            const skip = page * take;

            const [items, total] = await Promise.all([
                prisma.asset.findMany({
                    where,
                    include: {
                        account: { select: { alias: true } },
                        categories: {
                            select: {
                                id: true,
                                name: true,
                                nameEn: true,
                                slug: true,
                                slugEn: true,
                            },
                        },
                        tags: {
                            select: {
                                id: true,
                                slug: true,
                                name: true,
                                nameEn: true,
                            },
                        },
                    },
                    orderBy: { id: 'desc' },
                    skip,
                    take,
                }),
                prisma.asset.count({ where }),
            ]);

            const itemsSafe = toJsonSafe(items);
            return res.json({ items: itemsSafe, total, page, pageSize: take });
        }

        const items = await prisma.asset.findMany({
            where,
            include: {
                account: { select: { alias: true } },
                categories: {
                    select: {
                        id: true,
                        name: true,
                        nameEn: true,
                        slug: true,
                        slugEn: true,
                    },
                },
                tags: {
                    select: { id: true, slug: true, name: true, nameEn: true },
                },
            },
            orderBy: { id: 'desc' },
            take: 50,
        });
        const itemsSafe = toJsonSafe(items);
        return res.json(itemsSafe);
    } catch (e) {
        console.error('[ASSETS] list error:', e);
        return res.status(500).json({ message: 'Error listing assets' });
    }
};

// Buscar assets similares (para uploader): señal combinada por nombre + imagen + metadatos
// GET/POST /assets/similar?filename=naruto.rar&limit=8&sizeB=123456
export const similarAssets = async (req, res) => {
    try {
        const rawFilename = String(
            req.body?.filename || req.query?.filename || req.body?.q || req.query?.q || ''
        ).trim();
        if (!rawFilename)
            return res.status(400).json({ message: 'filename required' });

        const queryTitle = String(req.body?.title || req.query?.title || '').trim();
        const queryTitleEn = String(req.body?.titleEn || req.query?.titleEn || '').trim();

        const limit = Math.max(
            1,
            Math.min(25, Number(req.body?.limit ?? req.query?.limit) || 8)
        );
        const querySizeB = Number(
            req.body?.sizeB ??
                req.body?.sizeBytes ??
                req.query?.sizeB ??
                req.query?.sizeBytes ??
                0
        );
        const hasQuerySize = Number.isFinite(querySizeB) && querySizeB > 0;

        const bodyHashes = Array.isArray(req.body?.imageHashes)
            ? req.body.imageHashes
            : [];
        const queryHashesRaw =
            bodyHashes.length > 0
                ? bodyHashes
                : Array.isArray(req.query?.imageHashes)
                  ? req.query.imageHashes
                  : String(req.query?.imageHashes || '')
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean);
        const queryImageHashes = uniqueAHashHexes(queryHashesRaw, { max: 12 });

        const queryCategoryIds = parseNumberListInput(
            req.body?.categoryIds ?? req.query?.categoryIds,
            { max: 20 }
        );
        const queryCategorySlugsRaw = parseStringListInput(
            req.body?.categorySlugs ?? req.query?.categorySlugs,
            { max: 20 }
        );
        const queryCategorySlugs = uniqueStrings(
            queryCategorySlugsRaw
                .flatMap((s) => [String(s || '').toLowerCase(), safeName(s)])
                .filter(Boolean)
        ).slice(0, 24);

        const queryTagsRaw = parseStringListInput(req.body?.tags ?? req.query?.tags, {
            max: 40,
        });
        const queryTagSlugs = uniqueStrings(
            queryTagsRaw.map((t) => safeName(t)).filter(Boolean)
        ).slice(0, 36);
        const queryTagComparableSet = new Set(
            queryTagsRaw
                .flatMap((t) => [
                    normalizeForCompare(t),
                    normalizeForCompare(safeName(t)),
                ])
                .filter(Boolean)
        );

        const queryCategoryIdSet = new Set(queryCategoryIds);
        const queryCategorySlugSet = new Set(queryCategorySlugs);

        const queryCtx = tokenizeSimilarQuery(rawFilename);
        let {
            base,
            baseNorm,
            baseNoDigitsNorm,
            strongTokens,
            searchTerms,
            queryTokenSet,
            queryTrigrams,
            queryPhrase,
            queryCompact,
        } = queryCtx;

        if (queryTitle || queryTitleEn) {
            const extraTokens = toMeaningfulTokens(
                `${queryTitle} ${queryTitleEn}`,
                {
                    minLen: 3,
                    includePrefixes: true,
                }
            ).slice(0, 14);

            strongTokens = uniqueStrings([...(strongTokens || []), ...extraTokens]).slice(
                0,
                24
            );
            searchTerms = uniqueStrings([
                ...(searchTerms || []),
                queryTitle,
                queryTitleEn,
                ...extraTokens,
            ])
                .filter((t) => String(t || '').trim().length >= 2)
                .slice(0, 28);
            queryTokenSet = new Set([
                ...(queryTokenSet || []),
                ...extraTokens
                    .map((t) => normalizeForCompare(t))
                    .filter(Boolean),
            ]);
        }

        const stripExt = (s) => String(s || '').replace(/\.[a-z0-9]{1,6}$/i, '');

        const nameWhere = {};
        if (searchTerms.length) {
            const terms = searchTerms.slice(0, 18);
            nameWhere.OR = terms.flatMap((term) => [
                { archiveName: { contains: term } },
                { title: { contains: term } },
                { titleEn: { contains: term } },
                { slug: { contains: safeName(term) } },
            ]);
        }

        const pushCandidateId = (arr, set, id) => {
            const n = Number(id);
            if (!Number.isFinite(n) || n <= 0) return;
            if (set.has(n)) return;
            set.add(n);
            arr.push(n);
        };

        const candidateIdsOrdered = [];
        const candidateIdSet = new Set();
        const nameCandidateIdSet = new Set();
        const hashCandidateIdSet = new Set();
        const metaCandidateIdSet = new Set();

        const nameCandidates = await prisma.asset.findMany({
            where: nameWhere,
            select: { id: true },
            orderBy: { updatedAt: 'desc' },
            take: 1200,
        });
        for (const row of nameCandidates) {
            const id = Number(row?.id || 0);
            pushCandidateId(candidateIdsOrdered, candidateIdSet, id);
            if (id > 0) nameCandidateIdSet.add(id);
            if (candidateIdsOrdered.length >= 2200) break;
        }

        if (queryImageHashes.length > 0 && candidateIdsOrdered.length < 2200) {
            try {
                const hashPrefixes8 = uniqueStrings(
                    queryImageHashes
                        .map((h) => String(h || '').slice(0, 8))
                        .filter((h) => h.length === 8)
                ).slice(0, 12);
                const hashPrefixes6 = uniqueStrings(
                    queryImageHashes
                        .map((h) => String(h || '').slice(0, 6))
                        .filter((h) => h.length === 6)
                ).slice(0, 10);

                const hashOr = [];
                if (hashPrefixes8.length) hashOr.push({ hashPrefix: { in: hashPrefixes8 } });
                for (const p of hashPrefixes6) hashOr.push({ hashPrefix: { startsWith: p } });

                if (hashOr.length) {
                    const hashSeedRows = await prisma.assetImageHash.findMany({
                        where: { OR: hashOr },
                        select: { assetId: true },
                        orderBy: { updatedAt: 'desc' },
                        take: 12000,
                    });
                    for (const row of hashSeedRows) {
                        const id = Number(row?.assetId || 0);
                        pushCandidateId(candidateIdsOrdered, candidateIdSet, id);
                        if (id > 0) hashCandidateIdSet.add(id);
                        if (candidateIdsOrdered.length >= 2200) break;
                    }
                }
            } catch (e) {
                if (!isPrismaMissingTableError(e)) {
                    console.warn('[ASSETS][SIMILAR] hash seed warn:', e?.message || String(e));
                }
            }
        }

        const metaOr = [];
        if (queryCategoryIds.length > 0) {
            metaOr.push({ categories: { some: { id: { in: queryCategoryIds } } } });
        }
        if (queryCategorySlugs.length > 0) {
            metaOr.push({
                categories: {
                    some: {
                        OR: [
                            { slug: { in: queryCategorySlugs } },
                            { slugEn: { in: queryCategorySlugs } },
                        ],
                    },
                },
            });
        }
        if (queryTagSlugs.length > 0) {
            metaOr.push({ tags: { some: { slug: { in: queryTagSlugs } } } });
        }

        if (metaOr.length && candidateIdsOrdered.length < 2200) {
            try {
                const metaRows = await prisma.asset.findMany({
                    where: { OR: metaOr },
                    select: { id: true },
                    orderBy: { updatedAt: 'desc' },
                    take: 900,
                });
                for (const row of metaRows) {
                    const id = Number(row?.id || 0);
                    pushCandidateId(candidateIdsOrdered, candidateIdSet, id);
                    if (id > 0) metaCandidateIdSet.add(id);
                    if (candidateIdsOrdered.length >= 2200) break;
                }
            } catch (e) {
                console.warn('[ASSETS][SIMILAR] meta seed warn:', e?.message || String(e));
            }
        }

        const finalCandidateIds = candidateIdsOrdered.slice(0, 2200);
        if (!finalCandidateIds.length) {
            return res.json({
                query: rawFilename,
                base,
                tokens: strongTokens,
                imageHashCount: queryImageHashes.length,
                items: [],
            });
        }

        const items = await prisma.asset.findMany({
            where: { id: { in: finalCandidateIds } },
            select: {
                id: true,
                slug: true,
                title: true,
                titleEn: true,
                archiveName: true,
                archiveSizeB: true,
                fileSizeB: true,
                images: true,
                isPremium: true,
                status: true,
                updatedAt: true,
                createdAt: true,
                categories: {
                    select: {
                        id: true,
                        slug: true,
                        slugEn: true,
                        name: true,
                        nameEn: true,
                    },
                },
                tags: {
                    select: {
                        id: true,
                        slug: true,
                        name: true,
                        nameEn: true,
                    },
                },
            },
            orderBy: { updatedAt: 'desc' },
        });

        let assetHashesById = new Map();
        if (queryImageHashes.length > 0 && (items || []).length > 0) {
            try {
                const ids = uniqueStrings((items || []).map((it) => String(it?.id || '')).filter(Boolean))
                    .map((v) => Number(v))
                    .filter((n) => Number.isFinite(n) && n > 0);
                if (ids.length) {
                    const rows = await prisma.assetImageHash.findMany({
                        where: { assetId: { in: ids } },
                        select: { assetId: true, hashHex: true },
                    });
                    assetHashesById = rows.reduce((acc, row) => {
                        const id = Number(row?.assetId || 0);
                        const hx = normalizeAHashHex(row?.hashHex);
                        if (!id || !hx) return acc;
                        const prev = acc.get(id) || [];
                        prev.push(hx);
                        acc.set(id, prev);
                        return acc;
                    }, new Map());
                }
            } catch (e) {
                if (!isPrismaMissingTableError(e)) {
                    console.warn('[ASSETS][SIMILAR] hash read warn:', e?.message || String(e));
                }
                assetHashesById = new Map();
            }
        }

        const ranked = (items || [])
            .map((it) => {
                const candidateLast = stripExt(extractLastSegment(it?.archiveName || it?.slug || it?.title || ''));
                const candidateText = `${candidateLast} ${it.archiveName || ''} ${it.title || ''} ${it.titleEn || ''} ${it.slug || ''}`;
                const nameNorm = normalizeForCompare(candidateText);
                const keyNorm = normalizeForCompare(candidateLast);
                const keyNoDigitsNorm = normalizeForCompare(stripDigitsKeepLetters(candidateLast));
                const namePhraseNorm = normalizeSpacedText(candidateText);
                const candTrigrams = buildTrigramSet(keyNorm || nameNorm);
                const candTokenSet = tokenizeCandidateForScore(candidateText);
                const idNum = Number(it?.id || 0);

                let score = 0;
                let nameSignal = 0;
                let categorySignal = 0;
                let tagSignal = 0;

                // 1) Prioridad máxima: match exacto de nombre (base) contra el archivo/slug (sin extensión)
                if (baseNorm && keyNorm && keyNorm === baseNorm) nameSignal += 360;
                if (baseNoDigitsNorm && keyNoDigitsNorm && keyNoDigitsNorm === baseNoDigitsNorm) nameSignal += 320;

                if (baseNorm && nameNorm === baseNorm) nameSignal += 140;
                if (baseNoDigitsNorm && nameNorm === baseNoDigitsNorm) nameSignal += 130;
                if (baseNorm && nameNorm.includes(baseNorm)) nameSignal += 80;
                if (baseNoDigitsNorm && nameNorm.includes(baseNoDigitsNorm)) nameSignal += 75;

                if (queryCompact && keyNorm && queryCompact.includes(keyNorm) && keyNorm.length >= 6) nameSignal += 40;
                if (queryCompact && keyNorm && keyNorm.includes(queryCompact) && queryCompact.length >= 6) nameSignal += 40;

                for (const t of strongTokens || []) {
                    const tNorm = normalizeForCompare(t);
                    if (tNorm && nameNorm.includes(tNorm)) nameSignal += 18;
                }

                // 2) Cobertura de tokens (query vs candidato)
                if (queryTokenSet.size) {
                    let hits = 0;
                    for (const qt of queryTokenSet) {
                        if (candTokenSet.has(qt)) hits += 1;
                    }
                    const queryCoverage = hits / queryTokenSet.size;
                    const candCoverage = candTokenSet.size ? (hits / candTokenSet.size) : 0;
                    nameSignal += Math.round(95 * queryCoverage + 45 * candCoverage);
                    if (hits >= 2) nameSignal += 24;
                    if (hits === queryTokenSet.size && hits > 0) nameSignal += 28;
                }

                // 3) Similitud de cadena: trigramas + Levenshtein (tolerante a guiones/espacios/variantes)
                if (queryTrigrams?.size && candTrigrams?.size) {
                    const tri = jaccardSimilarity(queryTrigrams, candTrigrams);
                    nameSignal += Math.round(120 * tri);
                }
                if (baseNorm && (keyNorm || nameNorm)) {
                    const lev = levenshteinRatio(baseNorm, keyNorm || nameNorm);
                    if (lev >= 0.58) nameSignal += Math.round((lev - 0.55) * 140);
                }

                // 4) Frase normalizada con espacios (detecta matches por palabras aunque cambien guiones/orden parcial)
                if (queryPhrase && namePhraseNorm) {
                    if (namePhraseNorm.includes(queryPhrase)) nameSignal += 45;
                    const queryWords = queryPhrase.split(/\s+/g).filter(Boolean);
                    if (queryWords.length >= 2) {
                        let phraseHits = 0;
                        for (const qw of queryWords) {
                            if (qw.length >= 3 && namePhraseNorm.includes(qw)) phraseHits += 1;
                        }
                        const phraseRatio = phraseHits / queryWords.length;
                        nameSignal += Math.round(36 * phraseRatio);
                    }
                }

                score += nameSignal;

                if (hashCandidateIdSet.has(idNum)) score += 24;
                if (metaCandidateIdSet.has(idNum)) score += 10;
                if (nameCandidateIdSet.has(idNum)) score += 6;

                const imgCount = Array.isArray(it.images) ? it.images.length : 0;
                score += Math.min(20, imgCount * 2);
                if (it.archiveName) score += 5;
                if (String(it.status || '').toLowerCase() === 'published') score += 4;

                // 2) Peso similar (solo suma si ya hay similitud de nombre, para evitar falsos positivos por tamaño)
                if (hasQuerySize && nameSignal >= 22) {
                    const candSize = Number(it?.fileSizeB ?? it?.archiveSizeB ?? 0);
                    if (Number.isFinite(candSize) && candSize > 0) {
                        const denom = Math.max(querySizeB, candSize);
                        const diffRatio = denom ? Math.abs(candSize - querySizeB) / denom : 1;
                        // Bonus escalonado (más fuerte cuanto más cercano)
                        if (diffRatio <= 0.005) score += 85;
                        else if (diffRatio <= 0.015) score += 68;
                        else if (diffRatio <= 0.03) score += 52;
                        else if (diffRatio <= 0.06) score += 36;
                        else if (diffRatio <= 0.12) score += 24;
                        else if (diffRatio <= 0.2) score += 12;
                    }
                }

                let imageSignal = 0;
                let imageMatchCount = 0;
                let imageBestDistance = null;
                if (queryImageHashes.length > 0) {
                    const candidateHashes = assetHashesById.get(Number(it?.id || 0)) || [];
                    const imageScore = scoreImageHashSimilarity(
                        queryImageHashes,
                        candidateHashes
                    );
                    imageSignal = Number(imageScore?.score || 0);
                    imageMatchCount = Number(imageScore?.matchCount || 0);
                    imageBestDistance =
                        Number.isFinite(imageScore?.bestDistance)
                            ? Number(imageScore.bestDistance)
                            : null;
                    score += imageSignal;
                    if (imageMatchCount >= 2 && nameSignal >= 32) score += 24;
                }

                if (queryCategoryIdSet.size || queryCategorySlugSet.size) {
                    const candCategoryIdSet = new Set(
                        (it?.categories || [])
                            .map((c) => Number(c?.id || 0))
                            .filter((n) => Number.isFinite(n) && n > 0)
                    );
                    const candCategorySlugSet = new Set(
                        (it?.categories || [])
                            .flatMap((c) => [
                                String(c?.slug || '').toLowerCase(),
                                String(c?.slugEn || '').toLowerCase(),
                                safeName(c?.name || ''),
                                safeName(c?.nameEn || ''),
                            ])
                            .filter(Boolean)
                    );

                    let categoryHits = 0;
                    for (const qid of queryCategoryIdSet)
                        if (candCategoryIdSet.has(qid)) categoryHits += 1;
                    for (const qslug of queryCategorySlugSet)
                        if (candCategorySlugSet.has(qslug)) categoryHits += 1;

                    const totalCategorySignals =
                        queryCategoryIdSet.size + queryCategorySlugSet.size;
                    if (categoryHits > 0 && totalCategorySignals > 0) {
                        const categoryCoverage = categoryHits / totalCategorySignals;
                        categorySignal += Math.round(72 * categoryCoverage);
                        categorySignal += Math.min(36, categoryHits * 14);
                        score += categorySignal;
                    }
                }

                if (queryTagComparableSet.size) {
                    const candTagComparableSet = new Set(
                        (it?.tags || [])
                            .flatMap((t) => [
                                normalizeForCompare(t?.slug || ''),
                                normalizeForCompare(t?.name || ''),
                                normalizeForCompare(t?.nameEn || ''),
                            ])
                            .filter(Boolean)
                    );
                    let tagHits = 0;
                    for (const qt of queryTagComparableSet) {
                        if (candTagComparableSet.has(qt)) tagHits += 1;
                    }

                    if (tagHits > 0) {
                        const tagCoverage = tagHits / queryTagComparableSet.size;
                        tagSignal += Math.round(62 * tagCoverage);
                        tagSignal += Math.min(30, tagHits * 10);
                        score += tagSignal;
                    }
                }

                if (categorySignal > 0 && tagSignal > 0) score += 14;
                if (imageSignal >= 80 && (categorySignal > 0 || tagSignal > 0)) score += 16;
                if (imageSignal >= 70 && nameSignal >= 35) score += 14;

                return {
                    ...it,
                    _score: score,
                    _nameSignal: nameSignal,
                    _imageSignal: imageSignal,
                    _categorySignal: categorySignal,
                    _tagSignal: tagSignal,
                    _imageMatchCount: imageMatchCount,
                    _imageBestDistance: imageBestDistance,
                    _sourceByName: nameCandidateIdSet.has(idNum),
                    _sourceByImage: hashCandidateIdSet.has(idNum),
                    _sourceByMeta: metaCandidateIdSet.has(idNum),
                };
            })
            .sort((a, b) => {
                if (b._score !== a._score) return b._score - a._score;
                return Number(new Date(b.updatedAt)) - Number(new Date(a.updatedAt));
            });

        const filtered = ranked.filter(
            (it) =>
                it._score >= 26 ||
                it._nameSignal >= 16 ||
                it._imageSignal >= 34 ||
                it._categorySignal >= 24 ||
                it._tagSignal >= 20
        );
        const scored = (filtered.length ? filtered : ranked).slice(0, limit);

        const safe = toJsonSafe(scored).map(
            ({
                _score,
                _nameSignal,
                _imageSignal,
                _categorySignal,
                _tagSignal,
                _imageMatchCount,
                _imageBestDistance,
                _sourceByName,
                _sourceByImage,
                _sourceByMeta,
                ...rest
            }) => ({
                ...rest,
                _similarity: {
                    score: Number(_score || 0),
                    name: Number(_nameSignal || 0),
                    image: Number(_imageSignal || 0),
                    category: Number(_categorySignal || 0),
                    tags: Number(_tagSignal || 0),
                    imageMatchCount: Number(_imageMatchCount || 0),
                    imageBestDistance: Number.isFinite(_imageBestDistance)
                        ? Number(_imageBestDistance)
                        : null,
                    source: {
                        byName: !!_sourceByName,
                        byImage: !!_sourceByImage,
                        byMeta: !!_sourceByMeta,
                    },
                },
            })
        );
        return res.json({
            query: rawFilename,
            base,
            tokens: strongTokens,
            imageHashCount: queryImageHashes.length,
            inputSignals: {
                title: queryTitle,
                titleEn: queryTitleEn,
                categoryIds: queryCategoryIds,
                categorySlugs: queryCategorySlugs,
                tags: queryTagsRaw,
            },
            items: safe,
        });
    } catch (e) {
        console.error('[ASSETS] similarAssets error:', e);
        return res.status(500).json({ message: 'Error searching similar assets' });
    }
};

// GET /assets/similar/hash/stats
export const getAssetImageHashStats = async (_req, res) => {
    try {
        const [assetsTotal, hashRows] = await Promise.all([
            prisma.asset.count(),
            prisma.assetImageHash.count(),
        ]);
        return res.json({
            assetsTotal,
            hashRows,
            backfill: { ...assetHashBackfillState },
        });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tablas de hash aún no existen. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][HASH] stats error:', e);
        return res.status(500).json({ message: 'Error getting hash stats' });
    }
};

// GET /assets/similar/hash/backfill-status
export const getAssetImageHashBackfillStatus = async (_req, res) => {
    try {
        return res.json({ ...assetHashBackfillState });
    } catch (e) {
        console.error('[ASSETS][HASH] backfill status error:', e);
        return res.status(500).json({ message: 'Error getting backfill status' });
    }
};

// POST /assets/similar/hash/backfill
export const startAssetImageHashBackfill = async (req, res) => {
    try {
        if (assetHashBackfillState.running) {
            return res.status(202).json({
                started: false,
                message: 'Backfill ya está en ejecución',
                state: { ...assetHashBackfillState },
            });
        }

        const batchSize = Number(req.body?.batchSize || 100);
        setImmediate(() => {
            runAssetImageHashBackfill({ batchSize }).catch((e) => {
                assetHashBackfillState.lastError = e?.message || String(e);
            });
        });

        return res.status(202).json({
            started: true,
            state: { ...assetHashBackfillState, running: true },
        });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tablas de hash aún no existen. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][HASH] start backfill error:', e);
        return res.status(500).json({ message: 'Error starting hash backfill' });
    }
};

// GET /assets/similar/ignored-signatures
export const listIgnoredSimilarSignatures = async (_req, res) => {
    try {
        const items = await prisma.assetSimilarIgnoreSignature.findMany({
            orderBy: { updatedAt: 'desc' },
            take: 10000,
        });
        return res.json({ items });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes de similitud no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] list ignored signatures error:', e);
        return res.status(500).json({ message: 'Error listing ignored signatures' });
    }
};

// POST /assets/similar/ignored-signatures
export const upsertIgnoredSimilarSignature = async (req, res) => {
    try {
        const signature = normalizeSignatureForStore(req.body?.signature);
        if (!signature) {
            return res.status(400).json({ message: 'signature required' });
        }

        const reason = String(req.body?.reason || '').trim() || null;
        const assetIds = Array.isArray(req.body?.assetIds)
            ? req.body.assetIds
                  .map((n) => Number(n))
                  .filter((n) => Number.isFinite(n) && n > 0)
            : [];

        const saved = await prisma.assetSimilarIgnoreSignature.upsert({
            where: { signature },
            create: {
                signature,
                reason,
                assetIds: assetIds.length ? assetIds : null,
            },
            update: {
                reason,
                assetIds: assetIds.length ? assetIds : null,
            },
        });

        return res.json({ ok: true, item: saved });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes de similitud no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] upsert ignored signature error:', e);
        return res.status(500).json({ message: 'Error saving ignored signature' });
    }
};

// DELETE /assets/similar/ignored-signatures
export const clearIgnoredSimilarSignatures = async (_req, res) => {
    try {
        const r = await prisma.assetSimilarIgnoreSignature.deleteMany({});
        return res.json({ ok: true, deleted: r.count || 0 });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes de similitud no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] clear ignored signatures error:', e);
        return res.status(500).json({ message: 'Error clearing ignored signatures' });
    }
};

// DELETE /assets/similar/ignored-signatures/:signature
export const deleteIgnoredSimilarSignature = async (req, res) => {
    try {
        const signature = normalizeSignatureForStore(
            decodeURIComponent(String(req.params.signature || ''))
        );
        if (!signature)
            return res.status(400).json({ message: 'signature required' });

        await prisma.assetSimilarIgnoreSignature.deleteMany({
            where: { signature },
        });
        return res.json({ ok: true });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes de similitud no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] delete ignored signature error:', e);
        return res.status(500).json({ message: 'Error deleting ignored signature' });
    }
};

// GET /assets/similar/ignored-pairs
export const listIgnoredSimilarPairs = async (_req, res) => {
    try {
        const items = await prisma.assetSimilarIgnorePair.findMany({
            orderBy: { updatedAt: 'desc' },
            take: 50000,
        });
        return res.json({ items });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes por par no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] list ignored pairs error:', e);
        return res.status(500).json({ message: 'Error listing ignored pairs' });
    }
};

// POST /assets/similar/ignored-pairs
export const upsertIgnoredSimilarPairs = async (req, res) => {
    try {
        const rawPairs = Array.isArray(req.body?.pairs)
            ? req.body.pairs
            : [
                  {
                      assetAId: req.body?.assetAId,
                      assetBId: req.body?.assetBId,
                  },
              ];

        const uniq = new Map();
        for (const p of rawPairs) {
            const norm = normalizePairForStore(p?.assetAId, p?.assetBId);
            if (!norm) continue;
            uniq.set(`${norm.assetAId}:${norm.assetBId}`, norm);
        }
        const pairs = Array.from(uniq.values());
        if (!pairs.length) {
            return res.status(400).json({
                message: 'pairs required (assetAId/assetBId válidos y distintos)',
            });
        }

        const reason = String(req.body?.reason || '').trim() || null;
        const saved = [];
        for (const pair of pairs) {
            const row = await prisma.assetSimilarIgnorePair.upsert({
                where: {
                    assetAId_assetBId: {
                        assetAId: pair.assetAId,
                        assetBId: pair.assetBId,
                    },
                },
                create: {
                    assetAId: pair.assetAId,
                    assetBId: pair.assetBId,
                    reason,
                },
                update: { reason },
            });
            saved.push(row);
        }

        return res.json({ ok: true, count: saved.length, items: saved });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes por par no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] upsert ignored pairs error:', e);
        return res.status(500).json({ message: 'Error saving ignored pairs' });
    }
};

// DELETE /assets/similar/ignored-pairs
export const clearIgnoredSimilarPairs = async (_req, res) => {
    try {
        const r = await prisma.assetSimilarIgnorePair.deleteMany({});
        return res.json({ ok: true, deleted: r.count || 0 });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes por par no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] clear ignored pairs error:', e);
        return res.status(500).json({ message: 'Error clearing ignored pairs' });
    }
};

// DELETE /assets/similar/ignored-pairs/:assetAId/:assetBId
export const deleteIgnoredSimilarPair = async (req, res) => {
    try {
        const pair = normalizePairForStore(
            req.params?.assetAId,
            req.params?.assetBId
        );
        if (!pair) {
            return res.status(400).json({
                message: 'assetAId/assetBId inválidos o iguales',
            });
        }

        await prisma.assetSimilarIgnorePair.deleteMany({
            where: {
                assetAId: pair.assetAId,
                assetBId: pair.assetBId,
            },
        });
        return res.json({ ok: true });
    } catch (e) {
        if (isPrismaMissingTableError(e)) {
            return res.status(503).json({
                message:
                    'Tabla de descartes por par no existe aún. Ejecuta tu migración de Prisma y reintenta.',
            });
        }
        console.error('[ASSETS][SIMILAR] delete ignored pair error:', e);
        return res.status(500).json({ message: 'Error deleting ignored pair' });
    }
};

// Verificar si un slug/carpeta ya existe (DB y/o FS local) y sugerir uno disponible
export const checkAssetUnique = async (req, res) => {
    try {
        const raw = req.query?.slug || req.query?.folder || ''
        const slug = safeName(String(raw))
        if (!slug) return res.status(400).json({ message: 'slug required' })

        let existsDb = false
        try {
            const found = await prisma.asset.findUnique({ where: { slug }, select: { id: true } })
            console.log('[ASSETS] checkAssetUnique found:', found)
            existsDb = !!found
        } catch {}

        const existsLocal = fs.existsSync(path.join(ARCHIVES_DIR, slug)) || fs.existsSync(path.join(IMAGES_DIR, slug))
        const conflict = existsDb || existsLocal

        let suggestion = slug
        if (conflict) {
            try { suggestion = await generateUniqueSlug(slug) } catch {}
        }

        return res.json({ slug, conflict, existsDb, existsLocal, suggestion })
    } catch (e) {
        console.error('[ASSETS] checkAssetUnique error:', e)
        return res.status(500).json({ message: 'Error checking slug' })
    }
}

// Obtener un asset específico con relaciones básicas
export const getAsset = async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ message: 'Invalid id' });
        const asset = await prisma.asset.findUnique({
            where: { id },
            include: {
                account: { select: { id: true, alias: true, type: true } },
                categories: {
                    select: {
                        id: true,
                        name: true,
                        nameEn: true,
                        slug: true,
                        slugEn: true,
                    },
                },
                tags: {
                    select: {
                        id: true,
                        name: true,
                        nameEn: true,
                        slug: true,
                        slugEn: true,
                    },
                },
                replicas: {
                    select: { id: true, accountId: true, status: true },
                },
            },
        });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        const assetSafe = toJsonSafe(asset);
        return res.json(assetSafe);
    } catch (e) {
        console.error('[ASSETS] getAsset error:', e);
        return res.status(500).json({ message: 'Error getting asset' });
    }
};

export const updateAsset = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const existing = await prisma.asset.findUnique({ where: { id } });
        if (!existing)
            return res.status(404).json({ message: 'Asset not found' });

        const {
            title,
            titleEn,
            description,
            descriptionEn,
            categories,
            tags,
            isPremium,
            images,
        } = req.body;
        const data = {};
        if (title !== undefined) data.title = String(title);
        if (titleEn !== undefined) data.titleEn = String(titleEn);
        if (description !== undefined) data.description = normalizeDescriptionText(String(description)) || null;
        if (descriptionEn !== undefined) data.descriptionEn = normalizeDescriptionText(String(descriptionEn)) || null;
        if (typeof isPremium !== 'undefined')
            data.isPremium = Boolean(isPremium);
        if (Array.isArray(images)) {
            data.images = images
                .map((it) => String(it || '').trim())
                .filter(Boolean);
        }

        const catsParsed = parseCategoriesPayload(categories);
        if (catsParsed.length) {
            data.categories = { set: [], connect: catsParsed };
        }

        const tagsParsed = parseTagsPayload(tags);
        if (tagsParsed.length) {
            data.tags = { set: [], connect: tagsParsed };
        }

        const updated = await prisma.asset.update({
            where: { id },
            data,
            include: { categories: true, tags: true },
        });

        if (Array.isArray(images)) {
            try {
                await syncAssetImageHashes(id, updated.images || [], {
                    clearMissing: true,
                });
            } catch (hashErr) {
                console.warn(
                    `[ASSETS][HASH] sync warn asset=${id}:`,
                    hashErr?.message || String(hashErr)
                );
            }
        }
        
        qdrantService.upsertAssetVector(id).catch(err => console.error('[QDRANT] Update error:', err));
        
        const updatedSafe = toJsonSafe(updated);
        return res.json(updatedSafe);
    } catch (e) {
        console.error('[ASSETS] update error:', e);
        return res.status(500).json({ message: 'Error updating asset' });
    }
};

// POST /assets/meta/save-selected
export const saveSelectedAssetMeta = async (req, res) => {
    try {
        const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!rawItems.length) {
            return res.status(400).json({ message: 'items requerido' });
        }

        const items = rawItems
            .slice(0, 1000)
            .map((item) => ({
                id: Number(item?.id),
                title: item?.title,
                titleEn: item?.titleEn,
                description: item?.description,
                descriptionEn: item?.descriptionEn,
                categories: item?.categories,
                tags: item?.tags,
            }))
            .filter((item) => Number.isFinite(item.id) && item.id > 0);

        if (!items.length) {
            return res
                .status(400)
                .json({ message: 'items sin ids válidos' });
        }

        let updated = 0;
        let failed = 0;
        const details = [];
        const chunkSize = 20;

        for (let i = 0; i < items.length; i += chunkSize) {
            const chunk = items.slice(i, i + chunkSize);
            const settled = await Promise.allSettled(
                chunk.map(async (item) => {
                    const data = {
                        title: String(item.title || '').trim(),
                        titleEn: String(item.titleEn || '').trim(),
                        description:
                            normalizeDescriptionText(item.description) || null,
                        descriptionEn:
                            normalizeDescriptionText(item.descriptionEn) || null,
                    };

                    const catsParsed = parseCategoriesPayload(item.categories);
                    if (catsParsed.length) {
                        data.categories = { set: [], connect: catsParsed };
                    }

                    const tagsParsed = parseTagsPayload(item.tags);
                    if (tagsParsed.length) {
                        data.tags = { set: [], connect: tagsParsed };
                    }

                    await prisma.asset.update({
                        where: { id: item.id },
                        data,
                    });

                    return { id: item.id, updated: true };
                }),
            );

            settled.forEach((result, idx) => {
                const itemId = chunk[idx]?.id;
                if (result.status === 'fulfilled') {
                    updated += 1;
                    details.push(result.value);
                    return;
                }

                failed += 1;
                details.push({
                    id: itemId,
                    updated: false,
                    error: String(
                        result.reason?.message ||
                            result.reason ||
                            'ERROR_UPDATING_ASSET',
                    ),
                });
            });
        }

        return res.json({
            success: failed === 0,
            processed: items.length,
            updated,
            failed,
            items: details,
        });
    } catch (e) {
        console.error('[ASSETS][META] save selected error:', e);
        return res.status(500).json({ message: 'Error saving selected metadata' });
    }
};

// POST /assets/meta/generate-descriptions
export const generateAssetMetaDescriptions = async (req, res) => {
    try {
        const mode = String(req.body?.mode || 'selected').toLowerCase();
        const maxAssets = Math.max(1, Math.min(1000, Number(req.body?.limit) || 1000));
        const ids = Array.isArray(req.body?.assetIds)
            ? req.body.assetIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
            : [];

        console.info('[ASSETS][META][DESCRIPTION][START]', {
            mode,
            requestedIds: ids.length,
            maxAssets,
        });

        const where = {};
        if (mode === 'selected') {
            if (!ids.length) {
                return res.status(400).json({ message: 'assetIds requerido para mode=selected' });
            }
            where.id = { in: ids };
        } else if (mode === 'missing') {
            where.OR = [{ description: null }, { description: '' }, { descriptionEn: null }, { descriptionEn: '' }];
            if (ids.length) where.id = { in: ids };
        } else if (mode === 'all') {
            if (ids.length) where.id = { in: ids };
        } else {
            return res.status(400).json({ message: 'mode inválido. Usa: selected|missing|all' });
        }

        const targets = await prisma.asset.findMany({
            where,
            include: {
                categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
                tags: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
            },
            orderBy: { id: 'desc' },
            take: maxAssets,
        });

        if (!targets.length) {
            console.info('[ASSETS][META][DESCRIPTION][DONE]', {
                mode,
                processed: 0,
                updated: 0,
                failed: 0,
            });
            return res.json({ success: true, processed: 0, updated: 0, items: [] });
        }

        let updated = 0;
        let failed = 0;
        const details = [];
        const totalTargets = targets.length;

        for (let i = 0; i < targets.length; i += 1) {
            const asset = targets[i];
            const startPct = Math.round((i / totalTargets) * 100);
            console.info(`[ASSETS][META][DESCRIPTION][PROGRESS] ${startPct}% (${i}/${totalTargets}) asset=${asset.id} start`);

            try {
                const input = buildAssetMetaInput(asset);
                const generated = await generateSeoDescriptionForAsset(input, asset);
                const finalPair = await updateAssetDescriptionsSafely(
                    asset.id,
                    generated?.es || ASSET_DESCRIPTION_FALLBACK,
                    generated?.en || ASSET_DESCRIPTION_EN_FALLBACK,
                );

                updated += 1;
                details.push({
                    id: asset.id,
                    description: finalPair.description,
                    descriptionEn: finalPair.descriptionEn,
                    updated: true,
                });
                console.info('[ASSETS][META][DESCRIPTION][ITEM_OK]', {
                    assetId: asset.id,
                    descriptionLenEs: String(finalPair.description || '').length,
                    descriptionLenEn: String(finalPair.descriptionEn || '').length,
                });
            } catch (itemErr) {
                failed += 1;
                details.push({
                    id: asset.id,
                    updated: false,
                    error: String(itemErr?.message || itemErr || 'ERROR_GENERATING_DESCRIPTION'),
                });
                console.warn('[ASSETS][META][DESCRIPTION_ITEM_FAIL]', `asset=${asset.id}`, itemErr?.message || itemErr);
            } finally {
                const endPct = Math.round(((i + 1) / totalTargets) * 100);
                console.info(`[ASSETS][META][DESCRIPTION][PROGRESS] ${endPct}% (${i + 1}/${totalTargets})`);
            }
        }

        console.info('[ASSETS][META][DESCRIPTION][DONE]', {
            mode,
            processed: targets.length,
            updated,
            failed,
        });

        return res.json({
            success: true,
            processed: targets.length,
            updated,
            failed,
            items: details,
        });
    } catch (e) {
        console.error('[ASSETS][META] generate descriptions error:', e);
        return res.status(500).json({ message: 'Error generating descriptions' });
    }
};

// POST /assets/meta/generate-tags
export const generateAssetMetaTags = async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.assetIds)
            ? req.body.assetIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
            : [];
        if (!ids.length) {
            return res.status(400).json({ message: 'assetIds requerido' });
        }

        const targets = await prisma.asset.findMany({
            where: { id: { in: ids } },
            include: {
                categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
                tags: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
            },
        });

        let updated = 0;
        const details = [];

        for (const asset of targets) {
            const input = buildAssetMetaInput(asset);
            const generatedPairs = await generateSeoTagPairsForAsset(input);
            const tagIds = await ensureTagIdsFromPairs(generatedPairs);

            if (!tagIds.length) {
                details.push({ id: asset.id, updated: false, tags: [] });
                continue;
            }

            const connect = tagIds.map((id) => ({ id }));
            const row = await prisma.asset.update({
                where: { id: asset.id },
                data: {
                    tags: {
                        set: [],
                        connect,
                    },
                },
                include: {
                    tags: { select: { id: true, slug: true, name: true, nameEn: true } },
                },
            });

            updated += 1;
            details.push({
                id: asset.id,
                updated: true,
                tags: Array.isArray(row?.tags) ? row.tags.map((t) => ({ id: t.id, slug: t.slug, name: t.name, nameEn: t.nameEn })) : [],
            });

            // Reindexar vector para alinear búsqueda semántica con los tags recién generados.
            qdrantService
                .upsertAssetVector(asset.id)
                .catch((err) =>
                    console.error('[QDRANT] Tags generate sync error:', err),
                );
        }

        return res.json({
            success: true,
            processed: targets.length,
            updated,
            items: details,
        });
    } catch (e) {
        console.error('[ASSETS][META] generate tags error:', e);
        return res.status(500).json({ message: 'Error generating tags' });
    }
};

// 1) Subida temporal de archivo principal
export const uploadArchiveTemp = async (req, res) => {
    try {
        if (!req.file)
            return res
                .status(400)
                .json({ message: 'archive file is required' });
        // Responder con path temporal y metadata
        return res.json({
            tempPath: path.relative(UPLOADS_DIR, req.file.path),
            size: req.file.size,
            original: req.file.originalname,
        });
    } catch (e) {
        console.error('[ASSETS] upload archive error:', e);
        return res.status(500).json({ message: 'Error uploading archive' });
    }
};

// 2) Crear asset en DB, mover archivo temporal a definitivo y generar estructura
export const createAsset = async (req, res) => {
    let movedArchiveAbs = null;
    let createdInDb = false;
    try {
        const {
            title: rawTitle,
            titleEn,
            categories,
            tags,
            isPremium,
            accountId,
            tempArchivePath,
            archiveOriginal,
        } = req.body;
        if (!rawTitle) return res.status(400).json({ message: 'title required' });
        const title = rawTitle.startsWith('STL - ') ? rawTitle : `STL - ${rawTitle}`;
        if (!accountId)
            return res.status(400).json({ message: 'accountId required' });
        const accId = Number(accountId);
        let slug;
        try {
            slug = await generateUniqueSlug(safeName(title));
        } catch (e) {
            if (e.code === 'SLUG_EXHAUSTED')
                return res
                    .status(409)
                    .json({
                        code: 'SLUG_CONFLICT',
                        message: 'No hay slug disponible',
                        base: safeName(title),
                    });
            throw e;
        }

        // carpeta final de archivo: archives/slug (sin categoría legado)
        const finalDir = path.join(ARCHIVES_DIR, slug);
        ensureDir(finalDir);

        let archiveName = null,
            archiveSizeB = null,
            megaLink = null;

        if (tempArchivePath) {
            const absTemp = path.join(UPLOADS_DIR, tempArchivePath);
            const fname = archiveOriginal
                ? safeFileName(archiveOriginal)
                : path.basename(absTemp);
            const target = path.join(finalDir, fname);
            fs.renameSync(absTemp, target);
            movedArchiveAbs = target;
            archiveName = path.relative(UPLOADS_DIR, target);
            const szStat = fs.statSync(path.resolve(target), { bigint: true });
            archiveSizeB = szStat.size; // BigInt
            megaLink = megaLink;
        }

        const baseData = {
            title,
            titleEn: titleEn ? String(titleEn) : undefined,
            slug,
            isPremium: Boolean(isPremium),
            accountId: accId,
            archiveName,
            archiveSizeB,
            fileSizeB: archiveSizeB ?? null,
            megaLink,
            status: 'DRAFT',
        };

        // Conectar categorías/tags si se enviaron
        const catsParsed = parseCategoriesPayload(categories);
        const tagsParsed = parseTagsPayload(tags);

        try {
            const created = await prisma.asset.create({
                data: {
                    ...baseData,
                    ...(catsParsed.length
                        ? { categories: { connect: catsParsed } }
                        : {}),
                    ...(tagsParsed.length
                        ? { tags: { connect: tagsParsed } }
                        : {}),
                },
            });
            createdInDb = true;
            
            qdrantService.upsertAssetVector(created.id).catch(err => console.error('[QDRANT] Create error:', err));
            
            // Convertir BigInt a Number para JSON
            const createdSafe = {
                ...created,
                archiveSizeB: created.archiveSizeB != null ? Number(created.archiveSizeB) : null,
                fileSizeB: created.fileSizeB != null ? Number(created.fileSizeB) : null,
            };
            return res.status(201).json(createdSafe);
        } catch (e) {
            if (e?.code === 'P2002') {
                return res
                    .status(409)
                    .json({
                        code: 'SLUG_EXISTS',
                        message: 'El slug ya existe',
                        slug,
                    });
            }
            throw e;
        }
    } catch (e) {
        console.error('[ASSETS] create error:', e);
        try {
            if (!createdInDb && movedArchiveAbs && fs.existsSync(movedArchiveAbs)) {
                fs.unlinkSync(movedArchiveAbs);
                removeEmptyDirsUp(path.dirname(movedArchiveAbs), ARCHIVES_DIR);
            }
        } catch {}
        if (e?.code === 'SLUG_CONFLICT')
            return res
                .status(409)
                .json({
                    code: 'SLUG_CONFLICT',
                    message: 'No hay slug disponible',
                });
        return res
            .status(500)
            .json({ message: 'Error creating asset', error: e.message });
    }
};

// 3) Subida de imágenes SOLO si ya existe el asset (para no orphan)
export const uploadImages = async (req, res) => {
    try {
        const assetId = Number(req.params.assetId);
        const asset = await prisma.asset.findUnique({ where: { id: assetId } });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const replacing =
            String(req.query?.replace || '').toLowerCase() === 'true';

        const slug = asset.slug;

        // NUEVO: carpeta imágenes: images/slug (sin categoría)
        const baseDir = path.join(IMAGES_DIR, slug);
        const thumbsDir = path.join(baseDir, 'thumbs');
        ensureDir(baseDir);
        ensureDir(thumbsDir);

        const files = req.files || [];
        const stored = [];

        if (replacing) {
            const prev = Array.isArray(asset.images) ? asset.images : [];
            for (const rel of prev) {
                try {
                    const abs = path.join(UPLOADS_DIR, rel);
                    if (fs.existsSync(abs)) fs.unlinkSync(abs);
                    removeEmptyDirsUp(path.dirname(abs), IMAGES_DIR);
                } catch (e) {
                    console.warn('[ASSETS] replace cleanup warn:', e.message);
                }
            }
            try {
                if (fs.existsSync(thumbsDir)) {
                    for (const f of fs.readdirSync(thumbsDir)) {
                        try {
                            fs.unlinkSync(path.join(thumbsDir, f));
                        } catch {}
                    }
                }
            } catch {}
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const outName = `${Date.now()}_${i}.webp`;
            const dest = path.join(baseDir, outName);
            try {
                // Redimensionar a un ancho máximo de 700px manteniendo aspecto y sin ampliar
                await sharp(f.path)
                    .rotate()
                    .resize({ width: 700, withoutEnlargement: true })
                    .webp({ quality: 80, effort: 6 })
                    .toFile(dest);
            } finally {
                try {
                    fs.unlinkSync(f.path);
                } catch {}
            }
            const rel = path.relative(UPLOADS_DIR, dest);
            stored.push(rel);
        }

        const toThumb = stored.slice(0, 2);
        const thumbs = [];
        for (let i = 0; i < toThumb.length; i++) {
            const src = path.join(UPLOADS_DIR, toThumb[i]);
            const out = path.join(thumbsDir, `thumb_${i + 1}.webp`);
            await sharp(src)
                .resize(400, 400, { fit: 'inside' })
                .webp({ quality: 65, effort: 6 })
                .toFile(out);
            thumbs.push(path.relative(UPLOADS_DIR, out));
        }

        const imagesJson = Array.isArray(asset.images) ? asset.images : [];
        const newImages = replacing ? stored : imagesJson.concat(stored);

        const updated = await prisma.asset.update({
            where: { id: assetId },
            data: { images: newImages },
        });

        try {
            await syncAssetImageHashes(assetId, newImages, {
                clearMissing: true,
            });
        } catch (e) {
            console.warn(
                `[ASSETS][HASH] sync warn asset=${assetId}:`,
                e?.message || String(e)
            );
        }

        // Limpieza best-effort de temporales
        setTimeout(() => cleanTempDir(), 0);

        return res.json({ images: newImages, thumbs, replaced: replacing });
    } catch (e) {
        console.error('[ASSETS] upload images error:', e);
        return res.status(500).json({ message: 'Error uploading images' });
    }
};

// 4) Encolar subida a MEGA (solo el asset, no imágenes)
export const enqueueUploadToMega = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const asset = await prisma.asset.findUnique({ where: { id } });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const account = await prisma.megaAccount.findUnique({
            where: { id: asset.accountId },
        });
        if (!account)
            return res.status(400).json({ message: 'Account not found' });

        const archiveAbs = asset.archiveName
            ? path.join(UPLOADS_DIR, asset.archiveName)
            : null;
        if (!archiveAbs || !fs.existsSync(archiveAbs))
            return res
                .status(400)
                .json({ message: 'Archive not found on server' });

        // Log destino (informativo)
        const remoteBase = account.baseFolder || '/';
        const remotePath = path.posix.join(
            remoteBase.replaceAll('\\', '/'),
            asset.slug
        );
        console.log(
            `[ASSETS] enqueue upload asset id=${id} to MEGA ${remotePath}`
        );

        // Marcar como en proceso y disparar subida real a MEGA en background
        await prisma.asset.update({ where: { id }, data: { status: 'PROCESSING' } });
        setImmediate(() => {
            enqueueToMegaBatch(id)
                .catch(async (err) => {
                    console.error('[ASSETS] enqueueToMegaBatch error:', err);
                    try {
                        await prisma.asset.update({ where: { id }, data: { status: 'FAILED' } });
                    } catch {}
                });
        });

        return res.json({ message: 'Enqueued', status: 'PROCESSING' });
    } catch (e) {
        console.error('[ASSETS] enqueue error:', e);
        return res.status(500).json({ message: 'Error enqueuing upload' });
    }
};

// Flujo unificado: recibe archivo + imágenes, crea asset atómico y encola subida a MEGA
export const createAssetFull = async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 [SERVER METRICS] ===== RECIBIENDO UPLOAD =====');
    console.log('📊 [SERVER METRICS] Iniciado en:', new Date().toISOString());
    
    let cleanupPaths = [];
    let receivedBytes = 0;
    let lastLogTime = startTime;
    let createdInDb = false;
    
    try {
        const { title: rawTitle, titleEn, categories, tags, isPremium, accountId } =
            req.body;
        const title = rawTitle?.startsWith('STL - ') ? rawTitle : `STL - ${rawTitle}`;
        if (!title) return res.status(400).json({ message: 'title required' });
        
        const parseTime = Date.now();
        console.log('📝 [SERVER METRICS] Body parseado en:', parseTime - startTime, 'ms');
        
        if (!title) return res.status(400).json({ message: 'title required' });
        if (!accountId)
            return res.status(400).json({ message: 'accountId required' });
        const accId = Number(accountId);

        const archiveFile = (req.files?.archive || [])[0];
        const imageFiles = req.files?.images || [];
        if (!archiveFile)
            return res.status(400).json({ message: 'archive required' });

        // Métricas de archivos recibidos
        const archiveSize = archiveFile.size || 0;
        const imagesSize = (imageFiles || []).reduce((s, f) => s + (f.size || 0), 0);
        receivedBytes = archiveSize + imagesSize;
        
        console.log('📦 [SERVER METRICS] Archivos recibidos:', {
            archiveSize: `${(archiveSize / (1024*1024)).toFixed(1)} MB`,
            imagesCount: imageFiles?.length || 0,
            imagesSize: `${(imagesSize / (1024*1024)).toFixed(1)} MB`,
            totalSize: `${(receivedBytes / (1024*1024)).toFixed(1)} MB`,
            elapsed: `${parseTime - startTime}ms`,
            avgSpeed: `${((receivedBytes / (1024*1024)) / ((parseTime - startTime) / 1000)).toFixed(2)} MB/s`
        });

        let slug;
        const slugStart = Date.now();
        try {
            slug = await generateUniqueSlug(safeName(title));
        } catch (e) {
            if (e.code === 'SLUG_EXHAUSTED')
                return res
                    .status(409)
                    .json({
                        code: 'SLUG_CONFLICT',
                        message: 'No hay slug disponible',
                        base: safeName(title),
                    });
            throw e;
        }
        console.log('🔤 [SERVER METRICS] Slug generado en:', Date.now() - slugStart, 'ms');

        // carpetas definitivas
        const fsStart = Date.now();
        const archDir = path.join(ARCHIVES_DIR, slug); // archivo: sin carpeta por categoría
        const imgDir = path.join(IMAGES_DIR, slug); // imágenes solo por slug
        const thumbsDir = path.join(imgDir, 'thumbs');
        ensureDir(archDir);
        ensureDir(imgDir);
        ensureDir(thumbsDir);

        const targetName = safeFileName(
            archiveFile.originalname || archiveFile.filename
        );
        const archiveTarget = path.join(archDir, targetName);
        fs.renameSync(archiveFile.path, archiveTarget);
        cleanupPaths.push(archiveTarget);
        console.log('📁 [SERVER METRICS] Archivo movido en:', Date.now() - fsStart, 'ms');

        const imagesRel = [];
        const imageStart = Date.now();
        for (let i = 0; i < imageFiles.length; i++) {
            const f = imageFiles[i];
            const out = path.join(imgDir, `${Date.now()}_${i}.webp`);
            try {
                // Redimensionar a un ancho máximo de 700px manteniendo aspecto y sin ampliar
                await sharp(f.path)
                    .rotate()
                    .resize({ width: 700, withoutEnlargement: true })
                    .webp({ quality: 80, effort: 6 })
                    .toFile(out);
            } finally {
                try {
                    fs.unlinkSync(f.path);
                } catch {}
            }
            imagesRel.push(path.relative(UPLOADS_DIR, out));
            cleanupPaths.push(out);
        }
        console.log('🖼️ [SERVER METRICS] Imágenes procesadas en:', Date.now() - imageStart, 'ms');

        const thumbsStart = Date.now();
        const thumbs = [];
        for (let i = 0; i < Math.min(2, imagesRel.length); i++) {
            const src = path.join(UPLOADS_DIR, imagesRel[i]);
            const out = path.join(thumbsDir, `thumb_${i + 1}.webp`);
            await sharp(src)
                .resize(400, 400, { fit: 'inside' })
                .webp({ quality: 65, effort: 6 })
                .toFile(out);
            thumbs.push(path.relative(UPLOADS_DIR, out));
            cleanupPaths.push(out);
        }
        console.log('🖼️ [SERVER METRICS] Thumbnails generados en:', Date.now() - thumbsStart, 'ms');

        const baseData = {
            title,
            titleEn: titleEn ? String(titleEn) : undefined,
            slug,
            isPremium: Boolean(isPremium),
            accountId: accId,
            archiveName: path.relative(UPLOADS_DIR, archiveTarget),
            archiveSizeB: fs.statSync(archiveTarget, { bigint: true }).size, // BigInt
            fileSizeB: fs.statSync(archiveTarget, { bigint: true }).size,    // BigInt
            images: imagesRel,
            status: 'PROCESSING',
        };

        const catsParsed = parseCategoriesPayload(categories);
        const tagsParsed = parseTagsPayload(tags);

        let created;
        const dbStart = Date.now();
        try {
            created = await prisma.asset.create({
                data: {
                    ...baseData,
                    ...(catsParsed.length
                        ? { categories: { connect: catsParsed } }
                        : {}),
                    ...(tagsParsed.length
                        ? { tags: { connect: tagsParsed } }
                        : {}),
                },
            });
            createdInDb = true;
            console.log('💾 [SERVER METRICS] Asset creado en DB en:', Date.now() - dbStart, 'ms');
        } catch (e) {
            if (e?.code === 'P2002') {
                return res
                    .status(409)
                    .json({
                        code: 'SLUG_EXISTS',
                        message: 'El slug ya existe',
                        slug,
                    });
            }
            throw e;
        }

        try {
            await syncAssetImageHashes(created.id, imagesRel, {
                clearMissing: true,
            });
        } catch (e) {
            console.warn(
                `[ASSETS][HASH] sync warn asset=${created?.id}:`,
                e?.message || String(e)
            );
        }

        enqueueToMegaBatch(created.id).catch((err) =>
            console.error('[MEGA-UP][BATCH] async error:', err)
        );

        qdrantService.upsertAssetVector(created.id).catch(err => console.error('[QDRANT] CreateFull error:', err));

        // Evita cleanup accidental post-éxito ante errores posteriores no críticos.
        cleanupPaths = [];

        setTimeout(() => cleanTempDir(), 0);
        
        const endTime = Date.now();
        const totalTime = endTime - startTime;
        console.log('✅ [SERVER METRICS] Procesamiento completado:', {
            totalTime: `${totalTime}ms`,
            breakdown: {
                parsing: `${parseTime - startTime}ms`,
                slug: `${slugStart ? 'calculado' : 'N/A'}`,
                fileOps: `${fsStart ? 'calculado' : 'N/A'}`,
                images: `${imageStart ? Date.now() - imageStart : 'N/A'}ms`,
                database: `${Date.now() - dbStart}ms`
            },
            efficiency: 'completed',
            avgThroughput: `${((receivedBytes / (1024*1024)) / (totalTime / 1000)).toFixed(2)} MB/s`
        });
        
        // Convertir BigInt a Number para JSON
        const createdSafe = {
            ...created,
            archiveSizeB: created.archiveSizeB != null ? Number(created.archiveSizeB) : null,
            fileSizeB: created.fileSizeB != null ? Number(created.fileSizeB) : null,
        };
        return res.status(201).json(createdSafe);
    } catch (e) {
        const errorTime = Date.now();
        console.error('❌ [SERVER METRICS] Error en procesamiento:', {
            error: e?.message || String(e),
            timeToError: `${errorTime - startTime}ms`,
            receivedBytes: `${(receivedBytes / (1024*1024)).toFixed(1)} MB`,
            phase: 'server_processing'
        });
        console.error('[ASSETS] createFull error:', e);
        try {
            if (!createdInDb) {
                cleanupPaths.forEach((p) => {
                    if (p && fs.existsSync(p)) {
                        fs.unlinkSync(p);
                        try {
                            const abs = path.resolve(p);
                            if (abs.startsWith(path.resolve(ARCHIVES_DIR) + path.sep)) {
                                removeEmptyDirsUp(path.dirname(abs), ARCHIVES_DIR);
                            } else if (abs.startsWith(path.resolve(IMAGES_DIR) + path.sep)) {
                                removeEmptyDirsUp(path.dirname(abs), IMAGES_DIR);
                            }
                        } catch {}
                    }
                });
            }
        } catch {}
        if (e?.code === 'SLUG_CONFLICT')
            return res
                .status(409)
                .json({
                    code: 'SLUG_CONFLICT',
                    message: 'No hay slug disponible',
                });
        return res
            .status(500)
            .json({ message: 'Error creating asset', error: e.message });
    }
};

// Endpoint de prueba para medir velocidad pura de upload
export const testUploadSpeed = async (req, res) => {
    const startTime = Date.now();
    console.log('🧪 [SPEED TEST] Iniciando test de velocidad');
    
    let receivedBytes = 0;
    
    req.on('data', chunk => {
        receivedBytes += chunk.length;
    });
    
    req.on('end', () => {
        const endTime = Date.now();
        const seconds = (endTime - startTime) / 1000;
        const mbps = (receivedBytes / (1024 * 1024)) / seconds;
        
        const result = {
            size: `${(receivedBytes / (1024*1024)).toFixed(1)} MB`,
            time: `${seconds.toFixed(2)}s`,
            speed: `${mbps.toFixed(2)} MB/s`,
            timestamp: new Date().toISOString()
        };
        
        console.log('🧪 [SPEED TEST] Resultado:', result);
        res.json({ success: true, metrics: result });
    });
    
    req.on('error', (err) => {
        console.error('🧪 [SPEED TEST] Error:', err);
        res.status(500).json({ error: err.message });
    });
};

// Endpoint: progreso de subida a MEGA
export const getAssetProgress = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const asset = await prisma.asset.findUnique({
            where: { id },
            select: {
                status: true,
                accountId: true,
                account: {
                    select: {
                        backups: {
                            select: {
                                backupAccount: {
                                    select: {
                                        id: true,
                                        alias: true,
                                        type: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        if (!asset) return res.status(404).json({ message: 'Not found' });
        const progress =
            progressMap.get(id) ?? (asset.status === 'PUBLISHED' ? 100 : 0);
        return res.json({
            status: asset.status,
            progress: Math.max(0, Math.min(100, Math.round(progress))),
        });
    } catch (e) {
        return res.status(500).json({ message: 'Error getting progress' });
    }
};

// GET /api/assets/staged-status?path=tmp/<batch>/<file>&expectedSize=<bytes>
// Devuelve si existe el archivo en uploads/tmp, su tamaño actual y porcentaje estimado.
export const getStagedStatus = async (req, res) => {
    try {
        const rel = String(req.query?.path || '').trim();
        if (!rel) return res.status(400).json({ message: 'path required' });

        // Normalizar y asegurar que apunta dentro de uploads/tmp
        const normRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
        const abs = path.join(UPLOADS_DIR, normRel);
        const tmpRoot = path.resolve(TEMP_DIR) + path.sep; // uploads/tmp/
        const absResolved = path.resolve(abs);
        if (!absResolved.startsWith(tmpRoot)) {
            return res.status(400).json({ message: 'invalid path (must be under uploads/tmp)' });
        }

        let exists = false;
        let sizeB = 0;
        let mtimeMs = 0;
        try {
            const st = fs.statSync(absResolved);
            if (st.isFile()) {
                exists = true;
                sizeB = Number(st.size);
                mtimeMs = Number(st.mtimeMs);
            }
        } catch {}

        const expected = Number(req.query?.expectedSize || 0);
        let percent = undefined;
        if (exists && expected > 0) {
            percent = Math.max(0, Math.min(100, Math.floor((sizeB / expected) * 100)));
        }

        return res.json({ exists, path: normRel, sizeB, mtimeMs, percent });
    } catch (e) {
        console.error('[ASSETS] staged-status error:', e);
        return res.status(500).json({ message: 'Error getting staged status' });
    }
};

// GET/POST /api/assets/staged-status/batch
// Soporta:
//  - GET con query:   ?paths=<jsonEncodedArray>&expectedSizes=<jsonEncodedArray>
//  - POST con body:   { paths: string[], expectedSizes: number[] }
// Retorna un array de estados [{ path, exists, sizeB, mtimeMs, percent }]
export const getStagedStatusBatch = async (req, res) => {
    try {
        const isPost = String(req.method).toUpperCase() === 'POST'
        const pathsParam = isPost ? (req.body?.paths) : (req.query?.paths)
        const expectedParam = isPost ? (req.body?.expectedSizes) : (req.query?.expectedSizes)
        let paths = []
        let expectedSizes = []
        try {
            if (Array.isArray(pathsParam)) paths = pathsParam
            else paths = JSON.parse(String(pathsParam || '[]'))
        } catch { paths = [] }
        try {
            if (Array.isArray(expectedParam)) expectedSizes = expectedParam
            else expectedSizes = JSON.parse(String(expectedParam || '[]'))
        } catch { expectedSizes = [] }

        if (!Array.isArray(paths) || paths.length === 0) {
            return res.status(400).json({ message: 'paths array required' })
        }
    // Normalizar tamaños
    expectedSizes = (expectedSizes || []).map((v) => Number(v || 0))

        const tmpRoot = path.resolve(TEMP_DIR) + path.sep; // uploads/tmp/

        const results = paths.map((raw, idx) => {
            const rel = String(raw || '').trim()
            const normRel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
            const abs = path.join(UPLOADS_DIR, normRel)
            const absResolved = path.resolve(abs)
            if (!absResolved.startsWith(tmpRoot)) {
                return { path: normRel, exists: false, sizeB: 0, mtimeMs: 0, percent: undefined, error: 'invalid path' }
            }
            let exists = false
            let sizeB = 0
            let mtimeMs = 0
            try {
                const st = fs.statSync(absResolved)
                if (st.isFile()) {
                    exists = true
                    sizeB = Number(st.size)
                    mtimeMs = Number(st.mtimeMs)
                }
            } catch {}
            const expected = Number(expectedSizes[idx] || 0)
            let percent = undefined
            if (exists && expected > 0) {
                percent = Math.max(0, Math.min(100, Math.floor((sizeB / expected) * 100)))
            }
            return { path: normRel, exists, sizeB, mtimeMs, percent }
        })

        return res.json({ ok: true, data: results })
    } catch (e) {
        console.error('[ASSETS] staged-status batch error:', e)
        return res.status(500).json({ message: 'Error getting staged-status batch' })
    }
}

// GET/POST /api/assets/staged-status/batch-imports
// Igual que staged-status/batch, pero restringido a uploads/batch_imports.
export const getBatchImportsStagedStatus = async (req, res) => {
    try {
        const isPost = String(req.method).toUpperCase() === 'POST'
        const pathsParam = isPost ? (req.body?.paths) : (req.query?.paths)
        const expectedParam = isPost ? (req.body?.expectedSizes) : (req.query?.expectedSizes)
        let paths = []
        let expectedSizes = []
        try {
            if (Array.isArray(pathsParam)) paths = pathsParam
            else paths = JSON.parse(String(pathsParam || '[]'))
        } catch { paths = [] }
        try {
            if (Array.isArray(expectedParam)) expectedSizes = expectedParam
            else expectedSizes = JSON.parse(String(expectedParam || '[]'))
        } catch { expectedSizes = [] }

        if (!Array.isArray(paths) || paths.length === 0) {
            return res.status(400).json({ message: 'paths array required' })
        }

        expectedSizes = (expectedSizes || []).map((v) => Number(v || 0))
        const batchRoot = path.resolve(BATCH_IMPORTS_DIR) + path.sep

        const results = paths.map((raw, idx) => {
            const rel = String(raw || '').trim()
            const normRel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
            const abs = path.join(UPLOADS_DIR, normRel)
            const absResolved = path.resolve(abs)
            if (!absResolved.startsWith(batchRoot)) {
                return { path: normRel, exists: false, sizeB: 0, mtimeMs: 0, percent: undefined, error: 'invalid path' }
            }

            let exists = false
            let sizeB = 0
            let mtimeMs = 0
            try {
                const st = fs.statSync(absResolved)
                if (st.isFile()) {
                    exists = true
                    sizeB = Number(st.size)
                    mtimeMs = Number(st.mtimeMs)
                }
            } catch {}

            const expected = Number(expectedSizes[idx] || 0)
            let percent = undefined
            if (exists && expected > 0) {
                percent = Math.max(0, Math.min(100, Math.floor((sizeB / expected) * 100)))
            }
            return { path: normRel, exists, sizeB, mtimeMs, percent }
        })

        return res.json({ ok: true, data: results })
    } catch (e) {
        console.error('[ASSETS] staged-status batch-imports error:', e)
        return res.status(500).json({ message: 'Error getting staged-status batch-imports' })
    }
}

// GET /api/assets/scp-config (admin-only)
// Devuelve configuración de SCP desde el servidor (no incluye password)
export const getScpConfig = async (_req, res) => {
    try {
        const host = String(process.env.SCP_HOST || '').trim();
        const user = String(process.env.SCP_USER || '').trim();
        const port = Number(process.env.SCP_PORT || 22);
        const remoteBase = String(process.env.SCP_REMOTE_BASE || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
        return res.json({ host, user, port, remoteBase });
    } catch (e) {
        return res.status(500).json({ message: 'Error getting SCP config' });
    }
};

const getScpServerConfig = () => {
    const host = String(process.env.SCP_HOST || '').trim();
    const user = String(process.env.SCP_USER || '').trim();
    const port = Number(process.env.SCP_PORT || 22);
    const remoteBase = String(process.env.SCP_REMOTE_BASE || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
    return { host, user, port: Number.isFinite(port) && port > 0 ? port : 22, remoteBase };
};

const sanitizeBatchId = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '<batchId>';
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    return safe || '<batchId>';
};

const buildUploaderScpCommands = ({ host, user, port, remoteBase, batchId }) => {
    const safeBatchId = sanitizeBatchId(batchId);
    const remoteTmpDir = `${remoteBase}/uploads/tmp/${safeBatchId}`;
    const recommendedLocalFolder = safeBatchId;

    return {
        remoteTmpDir,
        recommendedLocalFolder,
        mkdirCmd: `ssh ${user}@${host} "mkdir -p ${remoteTmpDir}"`,
        singleFileCmd: `scp -P ${port} "C:\\ruta\\a\\tu\\archivo.zip" ${user}@${host}:${remoteTmpDir}/`,
        folderContentCmd: `cd C:\\stl-hub\\${recommendedLocalFolder}; scp -P ${port} -r .\\* ${user}@${host}:${remoteTmpDir}/`,
        winscpKeepupCmd: `Set-Location g:\\STLHUB; powershell -ExecutionPolicy Bypass -File .\\tools\\winscp-keepup.ps1 -BatchFolderName \"${recommendedLocalFolder}\"`,
    };
};

const buildBatchScpCommands = ({ host, user, port, remoteBase, filename }) => {
    const remoteBatchImportsDir = `${remoteBase}/uploads/batch_imports`;
    const wslBatchDir = String(process.env.SCP_WSL_BATCH_DIR || '/mnt/c/stl-hub/super-batch')
        .trim()
        .replace(/\\/g, '/');
    const safeFile = String(filename || '').trim().replace(/["\\]/g, '_').replace(/[\r\n]+/g, ' ')
    return {
        remoteBatchImportsDir,
        mkdirCmd: `ssh ${user}@${host} "mkdir -p ${remoteBatchImportsDir}"`,
        singleFileCmd: safeFile
            ? `cd C:\\stl-hub\\super-batch; scp -P ${port} "${safeFile}" ${user}@${host}:${remoteBatchImportsDir}/`
            : '',
        folderContentCmd: `cd C:\\stl-hub\\super-batch; scp -P ${port} -r .\\* ${user}@${host}:${remoteBatchImportsDir}/`,
        rsyncWslFileCmd: safeFile
            ? `rsync -avh --progress --partial --append-verify -e "ssh -p ${port}" "${wslBatchDir}/${safeFile}" ${user}@${host}:${remoteBatchImportsDir}/`
            : '',
        rsyncWslFolderCmd: `rsync -avh --progress --partial --append-verify -e "ssh -p ${port}" "${wslBatchDir}/" ${user}@${host}:${remoteBatchImportsDir}/`,
        winscpKeepupCmd: `Set-Location g:\\STLHUB; powershell -ExecutionPolicy Bypass -File .\\tools\\winscp-keepup.ps1 -BatchFolderName "super-batch" -LocalRoot "C:\\stl-hub" -HostName "${host}" -Port ${port} -UserName "${user}" -RemotePath "${remoteBatchImportsDir}"`,
    };
};

// POST /api/assets/scp-command (admin-only)
// Devuelve comandos SCP/WSL-RSYNC calculados en backend.
// Body:
//  - mode: 'uploader' | 'batch' (default: 'uploader')
//  - batchId?: string (solo uploader)
export const getScpCommand = async (req, res) => {
    try {
        const mode = String(req.body?.mode || 'uploader').toLowerCase();
        if (mode !== 'uploader' && mode !== 'batch') {
            return res.status(400).json({ message: 'mode inválido (uploader|batch)' });
        }

        const cfg = getScpServerConfig();
        if (!cfg.host || !cfg.user || !cfg.remoteBase) {
            return res.status(500).json({
                message: 'Configuración SCP incompleta en backend (.env)',
                missing: {
                    host: !cfg.host,
                    user: !cfg.user,
                    remoteBase: !cfg.remoteBase,
                },
            });
        }

        const commands =
            mode === 'batch'
                ? buildBatchScpCommands({ ...cfg, filename: req.body?.filename })
                : buildUploaderScpCommands({ ...cfg, batchId: req.body?.batchId });

        return res.json({ ok: true, mode, config: cfg, commands });
    } catch (e) {
        console.error('[ASSETS] scp-command error:', e);
        return res.status(500).json({ message: 'Error generating SCP command' });
    }
};

// POST /api/assets/hold-uploads-active (admin-only)
// Mantiene el lock global uploads-active durante una ventana larga (ej. modo SCP/formulario/cola)
// Body:
//  - minutes?: number (por defecto 360 = 6h)
//  - label?: string
//  - action?: 'start' | 'release' (por defecto 'start')
//  - holdId?: string (requerido para release)
// Nota: no toca MEGAcmd, solo el flag; el cron ya respeta este flag.
const uploadsActiveHolds = globalThis.__uploadsActiveHolds || new Map();
globalThis.__uploadsActiveHolds = uploadsActiveHolds;

export const holdUploadsActive = async (req, res) => {
    try {
        const action = String(req.body?.action || 'start').toLowerCase();
        const label = String(req.body?.label || 'uploads-hold').slice(0, 120);

        // Release temprano
        if (action === 'release') {
            const holdId = String(req.body?.holdId || '').trim();
            if (!holdId) return res.status(400).json({ message: 'holdId requerido' });
            const entry = uploadsActiveHolds.get(holdId);
            if (entry) {
                try { clearTimeout(entry.timeout); } catch {}
                try { entry.stop && entry.stop(); } catch {}
                uploadsActiveHolds.delete(holdId);
            }
            return res.json({ ok: true, released: true, holdId });
        }

        const minutesRaw = Number(req.body?.minutes ?? 360);
        const minutes = Math.max(5, Math.min(24 * 60, Number.isFinite(minutesRaw) ? minutesRaw : 360));
        const ms = minutes * 60 * 1000;

        // Import dinámico para no romper si el helper no está disponible por alguna razón
        const { startUploadsActive } = await import('../utils/uploadsActiveFlag.js');

        const holdId = `hold_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const stop = startUploadsActive(`${label}:${holdId}`);
        const timeout = setTimeout(() => {
            try { stop && stop(); } catch {}
            uploadsActiveHolds.delete(holdId);
        }, ms);

        uploadsActiveHolds.set(holdId, { stop, timeout, untilMs: Date.now() + ms, label });

        return res.json({ ok: true, holdId, minutes, untilMs: Date.now() + ms });
    } catch (e) {
        console.error('[ASSETS] hold-uploads-active error:', e);
        return res.status(500).json({ message: 'Error holding uploads-active', error: String(e.message || e) });
    }
};

// POST /api/assets/hold-mega-batch-quiet (admin-only)
// Mantiene un hold por cuenta MAIN para evitar pasar a BACKUP mientras el usuario sigue encolando por SCP.
// Body:
//  - mainAccountId: number (requerido)
//  - minutes?: number (por defecto 20)
//  - action?: 'start' | 'release' (por defecto 'start')
//  - label?: string
export const holdMegaBatchQuiet = async (req, res) => {
    try {
        const action = String(req.body?.action || 'start').toLowerCase();
        const mainAccountId = Number(req.body?.mainAccountId);
        if (!Number.isFinite(mainAccountId) || mainAccountId <= 0) {
            return res.status(400).json({ message: 'mainAccountId requerido' });
        }

        // Release
        if (action === 'release') {
            const entry = megaBatchQuietHolds.get(mainAccountId);
            if (entry) {
                try { clearTimeout(entry.timeout); } catch {}
                megaBatchQuietHolds.delete(mainAccountId);
            }
            return res.json({ ok: true, released: true, mainAccountId });
        }

        const label = String(req.body?.label || 'uploader-batch-quiet').slice(0, 120);
        const minutesRaw = Number(req.body?.minutes ?? 20);
        const minutes = Math.max(2, Math.min(6 * 60, Number.isFinite(minutesRaw) ? minutesRaw : 20)); // 2 min .. 6h
        const ms = minutes * 60 * 1000;
        const untilMs = Date.now() + ms;

        // Reemplazar/renovar
        const prev = megaBatchQuietHolds.get(mainAccountId);
        if (prev) {
            try { clearTimeout(prev.timeout); } catch {}
            megaBatchQuietHolds.delete(mainAccountId);
        }

        const timeout = setTimeout(() => {
            megaBatchQuietHolds.delete(mainAccountId);
        }, ms);
        megaBatchQuietHolds.set(mainAccountId, { untilMs, timeout, label });

        return res.json({ ok: true, mainAccountId, untilMs, minutes, label });
    } catch (e) {
        console.error('[ASSETS] hold-mega-batch-quiet error:', e);
        return res.status(500).json({ message: 'Error holding mega batch quiet', error: String(e.message || e) });
    }
};

// POST /api/assets/cut-mega-batch-to-backups (admin-only)
// Solicita cortar la fase MAIN del batch para una cuenta principal y pasar directamente a BACKUP.
// Efecto:
// - Termina el asset MAIN actual (no lo mata a mitad).
// - Descarta assets MAIN pendientes/no iniciados (se marcan como FAILED para que aparezcan como ERROR y se puedan reintentar).
// - Libera el hold batch-quiet si existe (para que BACKUP pueda arrancar).
export const cutMegaBatchToBackups = async (req, res) => {
    try {
        const mainAccountId = Number(req.body?.mainAccountId);
        if (!Number.isFinite(mainAccountId) || mainAccountId <= 0) {
            return res.status(400).json({ message: 'mainAccountId requerido' });
        }

        const st = megaBatchByMain.get(mainAccountId);
        if (!st || !st.running) {
            return res.status(409).json({ message: 'No hay un batch activo para esta cuenta' });
        }

        // Pedir el corte
        st.cutToBackupsRequested = true;
        st.cutRequestedAt = Date.now();

        // Liberar quiet-hold (si estaba activo) para permitir pasar a backups.
        try {
            const entry = megaBatchQuietHolds.get(mainAccountId);
            if (entry) {
                try { clearTimeout(entry.timeout); } catch {}
                megaBatchQuietHolds.delete(mainAccountId);
            }
        } catch {}

        const pendingIds = st.pending ? Array.from(st.pending) : [];
        try { st.pending && st.pending.clear(); } catch {}

        const mainQueue = Array.isArray(st.mainQueue) ? st.mainQueue.slice() : [];
        const mainIndex = Number(st.mainIndex) || 0;
        const dropFrom = st.currentAssetId ? (mainIndex + 1) : mainIndex;
        const queuedIds = mainQueue.slice(Math.max(0, dropFrom));

        const toFail = Array.from(new Set([...(pendingIds || []), ...(queuedIds || [])]))
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0);

        // Marcar como FAILED los descartados para que el usuario los vea como ERROR/reintente.
        for (const id of toFail) {
            try {
                await prisma.asset.update({ where: { id }, data: { status: 'FAILED' } });
            } catch {}
        }

        return res.json({
            ok: true,
            mainAccountId,
            phase: st.phase || null,
            currentAssetId: st.currentAssetId ?? null,
            dropped: {
                pending: pendingIds.length,
                mainQueueNotStarted: queuedIds.length,
                failedIds: toFail.length,
            },
        });
    } catch (e) {
        console.error('[ASSETS] cut-mega-batch-to-backups error:', e);
        return res.status(500).json({ message: 'Error cutting mega batch', error: String(e.message || e) });
    }
};

// POST /api/assets/unstick-mega-batch (admin-only)
// Fuerza un "desatasco" del batch MEGA de una cuenta MAIN:
// - Mata el mega-put actual (si existe)
// - Marca una solicitud para que el loop haga logout + relogin con proxy rotado
// Body:
//  - mainAccountId: number (requerido)
//  - reason?: string
export const unstickMegaBatch = async (req, res) => {
    try {
        const mainAccountId = Number(req.body?.mainAccountId);
        if (!Number.isFinite(mainAccountId) || mainAccountId <= 0) {
            return res.status(400).json({ message: 'mainAccountId requerido' });
        }

        const st = megaBatchByMain.get(mainAccountId);
        if (!st || !st.running) {
            return res.status(409).json({ message: 'No hay un batch activo para esta cuenta' });
        }

        const reason = String(req.body?.reason || 'manual-unstick').slice(0, 160);
        st.unstickRequested = true;
        st.unstickToken = Date.now();
        st.unstickRotateOffset = (Number(st.unstickRotateOffset) || 0) + 1;

        // Matar el proceso activo si está subiendo.
        try {
            if (st.activePutChild) {
                console.warn(`[BATCH][UNSTICK] killing active mega-put (${st.activePutLabel || 'unknown'}) reason=${reason}`);
                killProcessTreeBestEffort(st.activePutChild, 'MEGA-UNSTICK');
            }
        } catch {}

        return res.json({
            ok: true,
            mainAccountId,
            phase: st.phase || null,
            currentAssetId: st.currentAssetId ?? null,
            currentReplicaAssetId: st.currentReplicaAssetId ?? null,
            currentBackupAccountId: st.currentBackupAccountId ?? null,
            reason,
        });
    } catch (e) {
        console.error('[ASSETS] unstick-mega-batch error:', e);
        return res.status(500).json({ message: 'Error unstick mega batch', error: String(e.message || e) });
    }
};

// POST /api/assets/remove-from-mega-batch (admin-only)
// Elimina/omite un asset del batch en caliente.
// - Lo saca de pending y de colas en memoria
// - Si era el actual, mata el mega-put actual
// - Marca status FAILED (si aún no estaba PUBLISHED)
// - Marca réplicas PENDING/PROCESSING como FAILED (best-effort)
// Body:
//  - mainAccountId: number (requerido)
//  - assetId: number (requerido)
export const removeAssetFromMegaBatch = async (req, res) => {
    try {
        const mainAccountId = Number(req.body?.mainAccountId);
        const assetId = Number(req.body?.assetId);
        if (!Number.isFinite(mainAccountId) || mainAccountId <= 0) {
            return res.status(400).json({ message: 'mainAccountId requerido' });
        }
        if (!Number.isFinite(assetId) || assetId <= 0) {
            return res.status(400).json({ message: 'assetId requerido' });
        }

        const st = megaBatchByMain.get(mainAccountId);
        if (!st) {
            return res.status(409).json({ message: 'No hay estado de batch para esta cuenta' });
        }

        // Marcar como omitido desde este momento.
        try {
            if (!st.skipAssetIds) st.skipAssetIds = new Set();
            st.skipAssetIds.add(assetId);
        } catch {}

        const beforePending = st.pending ? st.pending.size : 0;
        try { st.pending && st.pending.delete(assetId); } catch {}
        const afterPending = st.pending ? st.pending.size : 0;

        const beforeMainQ = Array.isArray(st.mainQueue) ? st.mainQueue.length : 0;
        const beforeBackupQ = Array.isArray(st.backupQueue) ? st.backupQueue.length : 0;
        try { if (Array.isArray(st.mainQueue)) st.mainQueue = st.mainQueue.filter((x) => Number(x) !== assetId); } catch {}
        try { if (Array.isArray(st.backupQueue)) st.backupQueue = st.backupQueue.filter((x) => Number(x) !== assetId); } catch {}
        const afterMainQ = Array.isArray(st.mainQueue) ? st.mainQueue.length : 0;
        const afterBackupQ = Array.isArray(st.backupQueue) ? st.backupQueue.length : 0;

        const wasCurrentMain = Number(st.currentAssetId) === assetId;
        const wasCurrentBackup = Number(st.currentReplicaAssetId) === assetId;

        // Si está en curso, matar el proceso.
        if (wasCurrentMain || wasCurrentBackup) {
            try {
                if (st.activePutChild) {
                    console.warn(`[BATCH][REMOVE] killing active mega-put (${st.activePutLabel || 'unknown'}) asset=${assetId}`);
                    killProcessTreeBestEffort(st.activePutChild, 'MEGA-REMOVE');
                }
            } catch {}
        }

        // DB best-effort
        try {
            const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true, status: true } });
            if (a && String(a.status) !== 'PUBLISHED') {
                await prisma.asset.update({ where: { id: assetId }, data: { status: 'FAILED' } });
            }
        } catch {}

        try {
            // Fallar réplicas aún pendientes/en proceso (si existieran)
            await prisma.assetReplica.updateMany({
                where: { assetId, status: { in: ['PENDING', 'PROCESSING'] } },
                data: { status: 'FAILED', errorMessage: 'Removed from queue by user', finishedAt: new Date() },
            });
        } catch {}

        try { progressMap.delete(assetId); } catch {}
        try {
            const bid = Number(st.currentBackupAccountId);
            if (Number.isFinite(bid) && bid > 0) replicaProgressMap.delete(`${assetId}:${bid}`);
        } catch {}

        return res.json({
            ok: true,
            mainAccountId,
            assetId,
            removedFrom: {
                pending: beforePending - afterPending,
                mainQueue: beforeMainQ - afterMainQ,
                backupQueue: beforeBackupQ - afterBackupQ,
            },
            wasCurrentMain,
            wasCurrentBackup,
            phase: st.phase || null,
        });
    } catch (e) {
        console.error('[ASSETS] remove-from-mega-batch error:', e);
        return res.status(500).json({ message: 'Error removing from mega batch', error: String(e.message || e) });
    }
};

// GET /api/assets/uploads-root (admin-only, debug)
export const getUploadsRoot = async (_req, res) => {
    try {
        return res.json({
            uploadsDir: path.resolve(UPLOADS_DIR),
            tempDir: path.resolve(TEMP_DIR),
            cwd: process.cwd(),
        });
    } catch (e) {
        return res.status(500).json({ message: 'Error getting uploads root' });
    }
};

async function runCmd(cmd, args = [], options = {}) {
    const timeoutMs =
        Number(options.timeoutMs) ||
        (cmd === 'mega-login'
            ? Number(process.env.MEGA_LOGIN_TIMEOUT_MS) || 60000
            : cmd === 'mega-logout'
              ? Number(process.env.MEGA_LOGOUT_TIMEOUT_MS) || 30000
              : cmd === 'mega-mkdir'
                ? Number(process.env.MEGA_MKDIR_TIMEOUT_MS) || 20000
                : 0);

    const { timeoutMs: _ignored, ...spawnOpts } = options || {};

    return new Promise((resolve, reject) => {
        const killTree = () => {
            // En Linux, con detached podemos matar el grupo y evitar procesos huérfanos cuando shell=true.
            try {
                if (process.platform !== 'win32' && child?.pid) {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
                }
            } catch {}
            try { child.kill('SIGKILL'); } catch {}
            try { child.kill(); } catch {}
        };

        const child = spawn(cmd, args, {
            shell: true,
            detached: process.platform !== 'win32',
            ...spawnOpts,
        });
        let settled = false;
        let to = null;
        if (timeoutMs > 0) {
            to = setTimeout(() => {
                if (settled) return;
                settled = true;
                killTree();
                reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
            }, timeoutMs);
        }
        const normalizeChunk = (d) => String(d || '').replace(/\r/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
        const isMegaNoticeLine = (line) => {
            const m = String(line || '').toLowerCase();
            return (
                m.includes('revised terms') ||
                m.includes('terms of service') ||
                m.includes('privacy policy') ||
                m.includes('psa --discard') ||
                m.includes('[progreso transferencia]') ||
                /\|#+/.test(m)
            );
        };

        child.stdout.on('data', (d) => {
            const lines = normalizeChunk(d);
            for (const line of lines) console.log(`[MEGA] ${line}`);
        });
        child.stderr.on('data', (d) => {
            const lines = normalizeChunk(d);
            for (const line of lines) {
                if (isMegaNoticeLine(line)) console.warn(`[MEGA][NOTICE] ${line}`);
                else console.error(`[MEGA] ${line}`);
            }
        });
        child.on('error', (e) => {
            if (to) clearTimeout(to);
            if (settled) return;
            settled = true;
            try { killTree(); } catch {}
            reject(e);
        });
        child.on('close', (code) => {
            if (to) clearTimeout(to);
            if (settled) return;
            settled = true;
            code === 0
                ? resolve()
                : reject(new Error(`${cmd} exited ${code}`));
        });
    });
}

// mega-mkdir retorna código 54 cuando la carpeta ya existe; lo tratamos como éxito silencioso.
async function safeMkdir(remotePath) {
    const mkdirCmd = 'mega-mkdir';
    return new Promise((resolve, reject) => {
        const child = spawn(mkdirCmd, ['-p', remotePath], { shell: true });
        let stderrBuf = '';
        const timeoutMs = Number(process.env.MEGA_MKDIR_TIMEOUT_MS) || 20000;
        let settled = false;
        const to = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch {}
            try { child.kill(); } catch {}
            return reject(new Error(`${mkdirCmd} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) =>
            console.log(`[MEGA] ${d.toString().trim()}`)
        );
        child.stderr.on('data', (d) => {
            const s = d.toString();
            stderrBuf += s;
            console.error(`[MEGA] ${s.trim()}`);
        });
        child.on('error', (e) => {
            clearTimeout(to);
            if (settled) return;
            settled = true;
            return reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(to);
            if (settled) return;
            settled = true;
            if (code === 0) return resolve();
            if (code === 54 || /Folder already exists/i.test(stderrBuf)) {
                console.log(`[MEGA] mkdir exists (code=${code}) -> ok`);
                return resolve();
            }
            return reject(new Error(`${mkdirCmd} exited ${code}`));
        });
    });
}

function killProcessTreeBestEffort(child, label = 'PROC') {
    try {
        if (!child?.pid) return;
        const pid = Number(child.pid);
        if (!Number.isFinite(pid) || pid <= 0) return;

        if (process.platform === 'win32') {
            try {
                // /T mata el árbol; /F fuerza. No esperamos el exit.
                spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: true });
                console.warn(`[${label}] taskkill sent pid=${pid}`);
                return;
            } catch {}
        }

        // Linux/macOS: si el proceso fue lanzado detached, intentamos matar grupo.
        try { process.kill(-pid, 'SIGKILL'); } catch {}
        try { child.kill('SIGKILL'); } catch {}
        try { child.kill(); } catch {}
    } catch {}
}

async function megaPutWithProgressAndStall({
    srcPath,
    remotePath,
    progressKey,
    logPrefix,
    stallTimeoutMs,
    onProgress,
    onChild,
}) {
    const putCmd = 'mega-put';
    const timeoutMs = Math.max(0, Number(stallTimeoutMs) || 0);
    const startedAt = Date.now();

    return await new Promise((resolve, reject) => {
        const child = spawn(putCmd, [srcPath, remotePath], { shell: true });
        attachAutoAcceptTerms(child, logPrefix || 'MEGA PUT');

        try { onChild && onChild(child); } catch {}

        let settled = false;
        let lastLogged = -1;
        let lastPct = -1;
        let lastProgressAt = Date.now();
        let lastAnyOutputAt = Date.now();
        let stallTimer = null;

        const bumpOutput = () => {
            lastAnyOutputAt = Date.now();
        };

        const noteProgress = (p) => {
            const pct = Math.max(0, Math.min(100, Number(p)));
            if (!Number.isFinite(pct)) return;

            // Consideramos progreso "real" cuando aumenta.
            if (pct > lastPct) {
                lastPct = pct;
                lastProgressAt = Date.now();
            }

            try {
                if (progressKey) {
                    const prev = replicaProgressMap.get(progressKey) || 0;
                    if (pct === 100 || pct >= prev + 1) replicaProgressMap.set(progressKey, pct);
                }
            } catch {}

            try { onProgress && onProgress(pct); } catch {}

            if (pct === 100 || pct >= lastLogged + 5) {
                lastLogged = pct;
                if (logPrefix) console.log(`[PROGRESO] ${logPrefix} ${pct}%`);
            }
        };

        const parseProgress = (buf) => {
            bumpOutput();
            const txt = buf.toString();
            let last = null;
            const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g;
            let m;
            while ((m = re.exec(txt)) !== null) last = m[1];
            if (last !== null) {
                const p = parseFloat(last);
                if (Number.isFinite(p)) noteProgress(p);
            }
            if (/upload finished/i.test(txt)) {
                noteProgress(100);
            }
        };

        const cleanup = () => {
            if (stallTimer) clearInterval(stallTimer);
            stallTimer = null;
            try { onChild && onChild(null); } catch {}
        };

        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };

        const ok = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };

        if (timeoutMs > 0) {
            stallTimer = setInterval(() => {
                const now = Date.now();
                const idleMs = now - lastProgressAt;
                if (idleMs < timeoutMs) return;

                const aliveMs = now - lastAnyOutputAt;
                console.warn(
                    `[BATCH][STALL] mega-put sin progreso ${Math.round(idleMs / 1000)}s (aliveOutput=${Math.round(aliveMs / 1000)}s) lastPct=${lastPct} since=${Math.round((now - startedAt) / 1000)}s ${logPrefix || ''}`
                );
                try { killProcessTreeBestEffort(child, logPrefix || 'MEGA PUT'); } catch {}
                fail(new Error(`MEGA_PUT_STALL_TIMEOUT no progress for ${idleMs}ms`));
            }, 1000);
        }

        child.stdout.on('data', (d) => parseProgress(d));
        child.stderr.on('data', (d) => parseProgress(d));
        child.on('error', (e) => {
            try { killProcessTreeBestEffort(child, logPrefix || 'MEGA PUT'); } catch {}
            fail(e);
        });
        child.on('close', (code) => {
            if (settled) return;
            code === 0 ? ok() : fail(new Error(`${putCmd} exited ${code}`));
        });
    });
}

function pickTwoStickyProxies() {
    const proxies = listMegaProxies({});
    if (!proxies.length) return { proxies: [], mainProxy: null, backupProxy: null };
    const mainProxy = proxies[0];
    const backupProxy = proxies[1] || proxies[0];
    return { proxies, mainProxy, backupProxy };
}

function parseSizeToMB(str) {
    if (!str) return 0;
    const s = String(str).trim().toUpperCase();
    const m = s.match(/([0-9.,]+)\s*([KMGT]?B)?/);
    if (!m) return 0;
    const num = parseFloat(m[1].replace(',', '.'));
    const unit = m[2] || 'B';
    const factor =
        unit === 'KB'
            ? 1 / 1024
            : unit === 'MB'
              ? 1
              : unit === 'GB'
                ? 1024
                : unit === 'TB'
                  ? 1024 * 1024
                  : 1 / (1024 * 1024);
    return Math.round(num * factor);
}

async function runCmdCapture(cmd, args = [], { timeoutMs = 15000, maxBytes = 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { shell: true });
        let out = '';
        let err = '';
        let truncatedOut = false;
        let truncatedErr = false;
        let settled = false;
        const to = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch {}
            try { child.kill(); } catch {}
            reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
        }, Math.max(1, Number(timeoutMs) || 15000));

        const appendLimited = (prev, chunk, cap, markTruncated) => {
            if (prev.length + chunk.length <= cap) return { val: prev + chunk, truncated: false };
            const slice = cap - prev.length;
            if (slice > 0) return { val: prev + chunk.slice(0, slice), truncated: true };
            return { val: prev, truncated: true };
        };

        child.stdout.on('data', (d) => {
            if (truncatedOut) return;
            const r = appendLimited(out, d.toString(), maxBytes);
            out = r.val;
            if (r.truncated) truncatedOut = true;
        });
        child.stderr.on('data', (d) => {
            if (truncatedErr) return;
            const r = appendLimited(err, d.toString(), maxBytes);
            err = r.val;
            if (r.truncated) truncatedErr = true;
        });
        child.on('error', (e) => {
            clearTimeout(to);
            if (settled) return;
            settled = true;
            reject(e);
        });
        child.on('close', (code) => {
            clearTimeout(to);
            if (settled) return;
            settled = true;
            if (code === 0) return resolve({ out, err, truncatedOut, truncatedErr });
            reject(new Error(err || out || `${cmd} exited ${code}`));
        });
    });
}

async function refreshAccountStorageFromMegaDfInCurrentSession(accountId, ctx = '') {
    const id = Number(accountId);
    if (!Number.isFinite(id) || id <= 0) return;

    const DEFAULT_FREE_QUOTA_MB = Number(process.env.MEGA_FREE_QUOTA_MB) || 20480;
    const label = ctx ? ` ${ctx}` : '';
    const parseDfText = (txtRaw) => {
        const txt = String(txtRaw || '');
        let storageUsedMB = 0;
        let storageTotalMB = 0;

        let m =
            txt.match(/(?:USED\s+STORAGE|ALMACENAMIENTO\s+USADO):\s*([0-9.,]+(?:\s*[KMGT]?B)?)\s+[0-9.,]+%?\s+(?:of|de)\s+([0-9.,]+(?:\s*[KMGT]?B)?)/i) ||
            txt.match(/account\s+storage\s*:\s*([^/]+)\/\s*([^\n]+)/i) ||
            txt.match(/storage\s*:\s*([\d.,]+\s*[KMGT]?B)\s*of\s*([\d.,]+\s*[KMGT]?B)/i) ||
            txt.match(/([\d.,]+\s*[KMGT]?B)\s*\/\s*([\d.,]+\s*[KMGT]?B)/i) ||
            txt.match(/almacenamiento\s+de\s+la\s+cuenta\s*:\s*([^\n]+?)\s*de\s*([^\n]+)/i) ||
            txt.match(/almacenamiento\s*:\s*([\d.,]+\s*[KMGT]?B)\s*de\s*([\d.,]+\s*[KMGT]?B)/i);

        if (m) {
            storageUsedMB = parseSizeToMB(m[1]);
            storageTotalMB = parseSizeToMB(m[2]);
        }

        if (!storageTotalMB) {
            const p =
                txt.match(/storage[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:of|de)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:used|usado)?/i) ||
                txt.match(/almacenamiento[^\n]*?:\s*([\d.,]+)\s*%[^\n]*?(?:de|of)\s*([\d.,]+\s*[KMGT]?B)[^\n]*?(?:usado|used)?/i);
            if (p) {
                storageTotalMB = parseSizeToMB(p[2]);
                const pct = parseFloat(String(p[1]).replace(',', '.'));
                if (!Number.isNaN(pct) && Number.isFinite(pct) && storageTotalMB > 0) {
                    storageUsedMB = Math.round((pct / 100) * storageTotalMB);
                }
            }
        }

        if (!storageTotalMB || storageTotalMB <= 0) storageTotalMB = DEFAULT_FREE_QUOTA_MB;
        if (storageUsedMB > storageTotalMB) storageTotalMB = storageUsedMB;

        return { storageUsedMB, storageTotalMB };
    };

    try {
        const r = await runCmdCapture('mega-df', ['-h'], { timeoutMs: 15000, maxBytes: 512 * 1024 });
        const txt = (r.out || r.err || '').toString();
        const { storageUsedMB, storageTotalMB } = parseDfText(txt);
        await prisma.megaAccount.update({
            where: { id },
            data: {
                storageUsedMB,
                storageTotalMB,
                lastCheckAt: new Date(),
            },
        });
        console.log(`[BATCH][SPACE] updated accId=${id} used=${storageUsedMB}MB total=${storageTotalMB}MB${label}`);
        return;
    } catch (e) {
        console.warn(`[BATCH][SPACE] mega-df -h warn accId=${id} msg=${String(e.message).slice(0, 200)}${label}`);
    }

    // Fallback sin -h
    try {
        const r = await runCmdCapture('mega-df', [], { timeoutMs: 15000, maxBytes: 512 * 1024 });
        const txt = (r.out || r.err || '').toString();
        const { storageUsedMB, storageTotalMB } = parseDfText(txt);
        await prisma.megaAccount.update({
            where: { id },
            data: {
                storageUsedMB,
                storageTotalMB,
                lastCheckAt: new Date(),
            },
        });
        console.log(`[BATCH][SPACE] updated(accId=${id}) fallback used=${storageUsedMB}MB total=${storageTotalMB}MB${label}`);
    } catch (e) {
        console.warn(`[BATCH][SPACE] mega-df fallback warn accId=${id} msg=${String(e.message).slice(0, 200)}${label}`);
    }
}

async function applyProxyOrThrow(role, picked, ctx) {
    if (!picked) throw new Error(`[BATCH] Sin proxy para ${role}`);
    const r = await applyMegaProxy(picked, { ctx, timeoutMs: 15000, clearOnFail: false });
    if (!r?.enabled) throw new Error(`[BATCH] No pude aplicar proxy (${role})`);
    return r;
}

async function applyAnyWorkingProxyOrThrow(role, proxies, ctx, maxTries = 10) {
    const tries = Math.min(Math.max(1, Number(maxTries) || 1), proxies.length);
    let lastErr = '';
    for (let i = 0; i < tries; i++) {
        const p = proxies[i];
        try {
            await applyProxyOrThrow(role, p, ctx);
            return p;
        } catch (e) {
            lastErr = e?.message || String(e);
        }
    }
    throw new Error(`[BATCH] Ningún proxy funcionó para ${role}. lastErr=${String(lastErr).slice(0, 200)}`);
}

async function megaLogoutBestEffort(ctx) {
    try {
        await runCmd('mega-logout', []);
        console.log(`[MEGA][LOGOUT][OK] ${ctx}`);
    } catch {
        console.log(`[MEGA][LOGOUT][WARN] ${ctx}`);
    }
}

async function megaLoginOrThrow(payload, ctx) {
    const loginCmd = 'mega-login';
    if (payload?.type === 'session' && payload.session) {
        console.log(`[MEGA][LOGIN] session ${ctx}`);
        await runCmd(loginCmd, [payload.session]);
    } else if (payload?.username && payload?.password) {
        console.log(`[MEGA][LOGIN] user/pass ${ctx}`);
        await runCmd(loginCmd, [payload.username, payload.password]);
    } else {
        throw new Error('Invalid credentials payload');
    }
    console.log(`[MEGA][LOGIN][OK] ${ctx}`);
}

async function uploadOneAssetMainInCurrentSession(assetId, mainAcc, { onChild } = {}) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new Error(`Asset not found id=${assetId}`);
    if (asset.accountId !== mainAcc.id) throw new Error(`Asset ${assetId} no pertenece a main=${mainAcc.id}`);

    preUploadCleanup();
    const remoteBase = (mainAcc.baseFolder || '/').replaceAll('\\', '/');
    const remotePath = path.posix.join(remoteBase, asset.slug);
    const localArchive = asset.archiveName
        ? path.join(
              UPLOADS_DIR,
              asset.archiveName.startsWith('archives')
                  ? asset.archiveName
                  : path.join('archives', asset.archiveName)
          )
        : null;
    if (!localArchive || !fs.existsSync(localArchive)) throw new Error('Local archive not found');

    console.log(`[BATCH][MAIN] asset=${asset.id} -> ${remotePath}`);
    progressMap.set(asset.id, 0);

    let lastLoggedMain = -1;
    const exportCmd = 'mega-export';

    await safeMkdir(remotePath);

    // Stall watchdog: si no avanza el % en X ms, matamos mega-put.
    // Defaults: 3 minutos (se puede sobreescribir por env).
    const stallTimeoutMs =
        Number(process.env.MEGA_MAIN_STALL_TIMEOUT_MS) ||
        Number(process.env.MEGA_STALL_TIMEOUT_MS) ||
        3 * 60 * 1000;

    // Pasamos por el helper con stall para evitar subidas "pegadas" por horas.
    await megaPutWithProgressAndStall({
        srcPath: localArchive,
        remotePath,
        progressKey: null,
        logPrefix: `asset=${asset.id} main`,
        stallTimeoutMs,
        onProgress: (pct) => {
            try {
                const p = Math.max(0, Math.min(100, Math.round(pct)));
                const prev = progressMap.get(asset.id) || 0;
                if (p === 100 || p >= prev + 1) progressMap.set(asset.id, p);
                if (p === 100 || p >= lastLoggedMain + 5) {
                    lastLoggedMain = p;
                    console.log(`[PROGRESO] asset=${asset.id} main ${p}%`);
                }
            } catch {}
        },
        onChild,
    });

    // Link público
    let publicLink = null;
    try {
        const remoteFile = path.posix.join(remotePath, path.basename(localArchive));
        const out = await new Promise((resolve, reject) => {
            let buf = '';
            const child = spawn(exportCmd, ['-a', remoteFile], { shell: true });
            attachAutoAcceptTerms(child, 'UPLOAD EXPORT');
            child.stdout.on('data', (d) => (buf += d.toString()));
            child.stderr.on('data', (d) => (buf += d.toString()));
            child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error('export failed'))));
        });
        const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i);
        if (m) {
            publicLink = m[0];
            console.log(`[UPLOAD] link generado ${publicLink}`);
        }
    } catch (e) {
        console.warn('[UPLOAD] export warn:', e.message);
    }

    function stripArchivesPrefix(absPath) {
        const relFromArchives = path.relative(ARCHIVES_DIR, absPath);
        if (!relFromArchives.startsWith('..')) return relFromArchives;
        const relFromUploads = path.relative(UPLOADS_DIR, absPath);
        return relFromUploads.replace(/^archives[\\/]/i, '');
    }

    const nameWithoutPrefix = stripArchivesPrefix(localArchive);
    await prisma.asset.update({
        where: { id: asset.id },
        data: { status: 'PUBLISHED', archiveName: nameWithoutPrefix, megaLink: publicLink || undefined },
    });

    progressMap.set(asset.id, 100);
    console.log(`[BATCH][MAIN] ok asset=${asset.id}`);
    return asset.id;
}

async function ensureReplicaRows(assetId, backupAccounts) {
    for (const b of backupAccounts) {
        try {
            await prisma.assetReplica.upsert({
                where: { assetId_accountId: { assetId, accountId: b.id } },
                update: {},
                create: { assetId, accountId: b.id },
            });
        } catch (e) {
            console.warn('[REPLICA] upsert warn:', e.message);
        }
    }
}

async function replicateOneAssetToBackupInCurrentSession(assetId, backupAcc, { onChild } = {}) {
    const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: { account: true },
    });
    if (!asset) return;
    if (!asset.archiveName) return;

    const archiveAbs = path.join(
        UPLOADS_DIR,
        asset.archiveName.startsWith('archives') ? asset.archiveName : path.join('archives', asset.archiveName)
    );
    if (!fs.existsSync(archiveAbs)) {
        console.warn('[REPLICA] local archive missing, skip replicas');
        return;
    }

    let replica;
    try {
        replica = await prisma.assetReplica.findUnique({
            where: { assetId_accountId: { assetId: asset.id, accountId: backupAcc.id } },
        });
    } catch {}

    if (!replica || replica.status !== 'PENDING') return;

    preUploadCleanup();
    await prisma.assetReplica.update({
        where: { id: replica.id },
        data: { status: 'PROCESSING', startedAt: new Date() },
    });

    const remoteBase = (backupAcc.baseFolder || '/').replaceAll('\\', '/');
    const remotePath = path.posix.join(remoteBase, asset.slug);

    console.log(`[BATCH][BACKUP] asset=${asset.id} -> backupAcc=${backupAcc.id} path=${remotePath}`);

    const exportCmd = 'mega-export';
    let publicLink = null;

    await safeMkdir(remotePath);
    const fileName = path.basename(archiveAbs);
    // Default 3 minutos si no se configura env (petición: relogin+proxy si no progresa >3 min)
    const stallTimeoutMs = Number(process.env.MEGA_REPLICA_STALL_TIMEOUT_MS) || Number(process.env.MEGA_STALL_TIMEOUT_MS) || 3 * 60 * 1000;
    const progressKey = `${asset.id}:${backupAcc.id}`;
    await megaPutWithProgressAndStall({
        srcPath: archiveAbs,
        remotePath,
        progressKey,
        logPrefix: `asset=${asset.id} backup=${backupAcc.id}`,
        stallTimeoutMs,
        onChild,
    });

    try {
        const remoteFile = path.posix.join(remotePath, fileName);
        const out = await new Promise((resolve, reject) => {
            let buf = '';
            const child = spawn(exportCmd, ['-a', remoteFile], { shell: true });
            attachAutoAcceptTerms(child, 'REPLICA EXPORT');
            child.stdout.on('data', (d) => (buf += d.toString()));
            child.stderr.on('data', (d) => (buf += d.toString()));
            child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error('export failed'))));
        });
        const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i);
        if (m) publicLink = m[0];
    } catch (e) {
        console.warn('[REPLICA] export warn:', e.message);
    }

    replicaProgressMap.set(`${asset.id}:${backupAcc.id}`, 100);
    await prisma.assetReplica.update({
        where: { id: replica.id },
        data: { status: 'COMPLETED', finishedAt: new Date(), megaLink: publicLink || undefined, remotePath },
    });
    console.log(`[BATCH][BACKUP] ok asset=${asset.id} backupAcc=${backupAcc.id}`);
}

export async function enqueueToMegaBatch(assetId) {
    const id = Number(assetId);
    if (!Number.isFinite(id)) throw new Error('assetId inválido');
    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new Error('Asset not found');

    const mainId = Number(asset.accountId);
    if (!Number.isFinite(mainId)) throw new Error('accountId inválido');

    let st = megaBatchByMain.get(mainId);
    if (!st) {
        st = {
            pending: new Set(),
            running: false,
            phase: null,
            mainQueue: [],
            mainIndex: 0,
            backupQueue: [],
            backupIndex: 0,
            currentAssetId: null,
            currentReplicaAssetId: null,
            currentBackupAccountId: null,
            lastEnqueueAt: Date.now(),
            // Control runtime
            skipAssetIds: new Set(),
            unstickRequested: false,
            unstickToken: 0,
            unstickRotateOffset: 0,
            activePutChild: null,
            activePutLabel: null,
        };
        megaBatchByMain.set(mainId, st);
    }
    st.pending.add(id);
    st.lastEnqueueAt = Date.now();

    if (st.running) return;
    st.running = true;

    setImmediate(async () => {
        const stopFlag = startUploadsActive(`batch:main:${mainId}`);
        try {
            // Debounce de arranque: esperar una ventana corta sin nuevos enqueues antes de loguear.
            // Esto permite agrupar "cola de 3" cuando los assets llegan en ráfaga.
            const START_DEBOUNCE_MS = Math.max(0, Number(process.env.MEGA_BATCH_START_DEBOUNCE_MS || 5000));
            // Importante: si los enqueues NO paran (SCP/cola grande), no podemos esperar "silencio" infinito.
            // Máximo de espera para arrancar aunque sigan llegando nuevos assets.
            const START_DEBOUNCE_MAX_MS = Math.max(0, Number(process.env.MEGA_BATCH_START_DEBOUNCE_MAX_MS || 15000));
            // Si se acumulan suficientes pendientes, arrancar de inmediato aunque sigan llegando.
            const START_MIN_PENDING = Math.max(1, Number(process.env.MEGA_BATCH_START_MIN_PENDING || 3));
            if (START_DEBOUNCE_MS) {
                const startedAt = Date.now();
                while (true) {
                    const lastAt = Number(st.lastEnqueueAt) || 0;
                    const delta = Date.now() - lastAt;
                    const elapsed = Date.now() - startedAt;
                    if (st.pending.size > 0 && delta >= START_DEBOUNCE_MS) break;
                    if (st.pending.size >= START_MIN_PENDING) break;
                    if (START_DEBOUNCE_MAX_MS && elapsed >= START_DEBOUNCE_MAX_MS) break;
                    if (st.pending.size === 0) break;
                    await sleep(Math.min(500, Math.max(50, START_DEBOUNCE_MS - delta)));
                }
            }

            await withMegaLock(async () => {
                const mainAcc = await prisma.megaAccount.findUnique({
                    where: { id: mainId },
                    include: {
                        credentials: true,
                        backups: {
                            include: { backupAccount: { include: { credentials: true } } },
                        },
                    },
                });
                if (!mainAcc) throw new Error('Main account not found');
                if (!mainAcc.credentials) throw new Error('No credentials stored (main)');

                const { proxies, mainProxy, backupProxy } = pickTwoStickyProxies();
                const ctxMain = `mainAccId=${mainAcc.id} alias=${mainAcc.alias || '--'}`;
                if (!proxies.length) {
                    throw new Error(`[BATCH] Sin proxies válidos. (requisito: nunca IP directa) ${ctxMain}`);
                }

                // MAIN proxy + login 1 vez (rotando proxy si login falla)
                const mainPayload = decryptToJson(
                    mainAcc.credentials.encData,
                    mainAcc.credentials.encIv,
                    mainAcc.credentials.encTag
                );
                await megaLoginWithProxyRotationOrThrow('MAIN', mainPayload, proxies, ctxMain, { maxTries: 10 });

                const uploadedAssetIds = [];
                st.phase = 'main';
                st.mainQueue = [];
                st.mainIndex = 0;
                st.backupQueue = [];
                st.backupIndex = 0;
                st.currentAssetId = null;
                st.currentReplicaAssetId = null;
                st.currentBackupAccountId = null;
                // Ventana de batching:
                // - Consumir todo lo pendiente.
                // - Si no hay más pending, esperar un "quiet period" corto por si llegan más assets.
                // Esto reduce ciclos MAIN->BACKUP por asset cuando llegan en ráfaga.
                const QUIET_MS = Math.max(0, Number(process.env.MEGA_BATCH_QUIET_MS || 20000));
                const POLL_MS = Math.max(200, Number(process.env.MEGA_BATCH_QUIET_POLL_MS || 500));

                let idleSince = null;

                while (true) {
                    while (st.pending.size > 0 && !st.cutToBackupsRequested) {
                        idleSince = null;
                        const batch = Array.from(st.pending);
                        st.pending.clear();
                        st.mainQueue = batch.slice();
                        st.mainIndex = 0;
                        for (let i = 0; i < batch.length; i++) {
                            const aid = batch[i];
                            // Permitir eliminar/omitir assets en caliente.
                            if (st.skipAssetIds && st.skipAssetIds.has(aid)) {
                                try { await prisma.asset.update({ where: { id: aid }, data: { status: 'FAILED' } }); } catch {}
                                try { progressMap.delete(aid); } catch {}
                                st.mainIndex = (Number(st.mainIndex) || 0) + 1;
                                st.currentAssetId = null;
                                continue;
                            }

                            if (st.cutToBackupsRequested) {
                                // Corte solicitado: no iniciar más MAIN en este batch.
                                break;
                            }

                            st.currentAssetId = aid;
                            try {
                                // MAIN: reintentos por stall (sin progreso) + posibilidad de desatascar manual.
                                const maxStallRetries = Math.max(0, Number(process.env.MEGA_MAIN_STALL_MAX_RETRIES) || 4);
                                const backoffBaseMs = Math.max(0, Number(process.env.MEGA_MAIN_STALL_BACKOFF_MS) || 30000);
                                let attempt = 0;

                                while (true) {
                                    // Si alguien pidió desatascar entre assets, forzar relogin+proxy rotado.
                                    if (st.unstickRequested) {
                                        st.unstickRequested = false;
                                        try { await megaLogoutBestEffort(`UNSTICK ${ctxMain} asset=${aid}`); } catch {}
                                        const rotated = rotateArray(proxies, (Number(st.unstickRotateOffset) || 0) + 1);
                                        await megaLoginWithProxyRotationOrThrow('MAIN', mainPayload, rotated, `${ctxMain} unstick`, { maxTries: 10 });
                                    }

                                    // Si MEGAcmd pierde la sesión (exit 57), relogin y retry.
                                    const tokenBefore = Number(st.unstickToken) || 0;
                                    try {
                                        const okId = await uploadOneAssetMainInCurrentSession(aid, mainAcc, {
                                            onChild: (ch) => {
                                                try {
                                                    st.activePutChild = ch;
                                                    st.activePutLabel = ch ? `MAIN asset=${aid}` : null;
                                                } catch {}
                                            },
                                        });
                                        uploadedAssetIds.push(okId);
                                        break;
                                    } catch (e) {
                                        const wasUnstick = (Number(st.unstickToken) || 0) !== tokenBefore;
                                        const isStall = isMegaPutStallError(e) || wasUnstick;

                                        // Si el usuario eliminó este asset mientras estaba subiendo, saltar.
                                        if (st.skipAssetIds && st.skipAssetIds.has(aid)) {
                                            throw new Error('MEGA_BATCH_REMOVED_BY_USER');
                                        }

                                        if (isNotLoggedInError(e)) {
                                            console.warn(`[BATCH][MAIN] session lost asset=${aid} -> relogin & retry`);
                                            await megaLoginWithProxyRotationOrThrow('MAIN', mainPayload, proxies, ctxMain, { maxTries: 3 });
                                            continue;
                                        }

                                        if (!isStall || attempt >= maxStallRetries) throw e;

                                        const msg = String(e?.message || e || '');
                                        console.warn(`[BATCH][MAIN][STALL] asset=${aid} -> logout+rotate proxy+retry. attempt=${attempt + 1}/${maxStallRetries + 1} err=${msg.slice(0, 200)} ${ctxMain}`);

                                        try { await megaLogoutBestEffort(`STALL-RETRY ${ctxMain} asset=${aid}`); } catch {}
                                        const rotated = rotateArray(proxies, (Number(st.unstickRotateOffset) || 0) + attempt + 1);
                                        await megaLoginWithProxyRotationOrThrow('MAIN', mainPayload, rotated, `${ctxMain} stallRetry=${attempt + 1}`, { maxTries: 10 });

                                        const backoffMs = backoffBaseMs * Math.max(1, attempt + 1);
                                        if (backoffMs) {
                                            console.log(`[BATCH][MAIN][STALL] backoff ${Math.round(backoffMs / 1000)}s asset=${aid}`);
                                            await sleep(backoffMs);
                                        }
                                        attempt += 1;
                                    }
                                }
                            } catch (e) {
                                // Caso especial: eliminado por el usuario (desatascar).
                                if (String(e?.message || '').includes('MEGA_BATCH_REMOVED_BY_USER')) {
                                    console.warn(`[BATCH][MAIN] removed-by-user asset=${aid}`);
                                    try { progressMap.delete(aid); } catch {}
                                    try { await prisma.asset.update({ where: { id: aid }, data: { status: 'FAILED' } }); } catch {}
                                } else {
                                    console.error(`[BATCH][MAIN] fail asset=${aid} msg=${e.message}`);
                                    progressMap.delete(aid);
                                    try { await prisma.asset.update({ where: { id: aid }, data: { status: 'FAILED' } }); } catch {}
                                    await notifyBatchUploadFailure({
                                        phase: 'main',
                                        mainAccountId: mainId,
                                        assetId: aid,
                                        error: e?.message || e,
                                        extra: ctxMain,
                                    });
                                }

                                // Evitar fallos en cascada: si un comando deja a MEGAcmd sin sesión,
                                // re-loguear para que el resto de la cola pueda continuar.
                                try {
                                    if (isNotLoggedInError(e) || isLoginAccessDeniedError(e) || String(e?.message || '').includes('mega-put exited')) {
                                        await megaLoginWithProxyRotationOrThrow('MAIN', mainPayload, proxies, ctxMain, { maxTries: 3 });
                                    }
                                } catch (reLoginErr) {
                                    console.warn(`[BATCH][MAIN] relogin-after-fail warn asset=${aid} msg=${reLoginErr?.message || reLoginErr}`);
                                }
                            } finally {
                                // En batch dejamos el progreso en memoria hasta 100 o fallo; limpiar best-effort
                                try { progressMap.delete(aid); } catch {}
                                st.mainIndex = (Number(st.mainIndex) || 0) + 1;
                                st.currentAssetId = null;
                                st.activePutChild = null;
                                st.activePutLabel = null;
                            }

                            // Si alguien pidió corte mientras subíamos este asset, salimos del batch y pasamos a BACKUP.
                            if (st.cutToBackupsRequested) {
                                break;
                            }
                        }
                    }

                    // Corte solicitado: no esperar quiet window y pasar a BACKUP.
                    if (st.cutToBackupsRequested) break;

                    // Sin pendientes: esperar quiet si está habilitado
                    if (!QUIET_MS) break;
                    if (!idleSince) idleSince = Date.now();
                    const idleDelta = Date.now() - idleSince;
                    if (st.pending.size === 0) {
                        // Si el usuario mantiene un hold activo (SCP lento), no arrancar backups todavía.
                        if (isMegaBatchQuietHoldActive(mainId) && !st.cutToBackupsRequested) {
                            await sleep(POLL_MS);
                            continue;
                        }
                        if (idleDelta >= QUIET_MS) break;
                    }
                    // Si entró algo durante el wait, el loop externo volverá a consumir pending
                    await sleep(POLL_MS);
                }

                // Actualizar métricas de espacio de la cuenta MAIN tras completar subidas.
                // Esto alimenta /dashboard/assets/uploader (header) y /dashboard/accounts.
                try {
                    await refreshAccountStorageFromMegaDfInCurrentSession(mainAcc.id, ctxMain);
                } catch {}

                await megaLogoutBestEffort(`POST-MAIN ${ctxMain}`);

                // BACKUPS: el usuario usa 1 backup por main, pero soportamos N.
                const backupAccounts = (mainAcc.backups || [])
                    .map((b) => b.backupAccount)
                    .filter((b) => b && b.type === 'backup');

                const eligibleBackupAccountIds = backupAccounts
                    .filter((b) => b && b.credentials)
                    .map((b) => Number(b.id))
                    .filter((n) => Number.isFinite(n) && n > 0);

                if (!backupAccounts.length || !uploadedAssetIds.length) {
                    // Si no hay backups configurados, opcionalmente borrar el archivo local tras MAIN.
                    // Esto deja al sistema dependiendo de MEGA para el archivo grande.
                    if (!backupAccounts.length && uploadedAssetIds.length) {
                        for (const aid of uploadedAssetIds) {
                            await deleteLocalArchiveIfEligible(aid, { requiredBackupAccountIds: [], ctx: `mainAccId=${mainAcc.id}` });
                        }
                    }
                    st.cutToBackupsRequested = false;
                    st.cutRequestedAt = 0;
                    st.phase = null;
                    st.backupQueue = [];
                    st.backupIndex = 0;
                    return;
                }

                // Proxy BACKUP sticky (si solo hay 1 proxy, reutilizamos). También rota si falla.
                const ctxBackups = `mainAccId=${mainAcc.id} backups=${backupAccounts.length}`;
                const proxyBackupPicked = backupProxy || mainProxy;
                const orderedBackupProxies = [proxyBackupPicked, ...proxies.filter((p) => p !== proxyBackupPicked)];
                // Nota: el login de cada backup rota proxy si falla, pero precalentamos aplicación aquí.
                await applyAnyWorkingProxyOrThrow('BACKUP', orderedBackupProxies, ctxBackups, 3);

                for (const b of backupAccounts) {
                    if (!b.credentials) {
                        console.warn(`[BATCH][BACKUP] skip accId=${b.id} sin credenciales`);
                        continue;
                    }

                    await ensureReplicaRowsForBatch(uploadedAssetIds, b);

                    const payload = decryptToJson(
                        b.credentials.encData,
                        b.credentials.encIv,
                        b.credentials.encTag
                    );
                    const bctx = `backupAccId=${b.id} alias=${b.alias || '--'}`;
                    await megaLoginWithProxyRotationOrThrow('BACKUP', payload, orderedBackupProxies, bctx, { maxTries: 10 });

                    st.phase = 'backup';
                    st.backupQueue = uploadedAssetIds.slice();
                    st.backupIndex = 0;
                    st.currentReplicaAssetId = null;
                    st.currentBackupAccountId = b.id;

                    for (const aid of uploadedAssetIds) {
                        st.currentReplicaAssetId = aid;
                        try {
                            const maxStallRetries = Math.max(0, Number(process.env.MEGA_REPLICA_STALL_MAX_RETRIES) || 4);
                            const backoffBaseMs = Math.max(0, Number(process.env.MEGA_REPLICA_STALL_BACKOFF_MS) || 30000);

                            let attempt = 0;
                            // Intento 0 = normal; reintentos sólo si detectamos stall.
                            while (true) {
                                const tokenBefore = Number(st.unstickToken) || 0;
                                try {
                                    if (st.skipAssetIds && st.skipAssetIds.has(aid)) {
                                        // Eliminado por usuario: fallar la réplica y seguir.
                                        throw new Error('MEGA_BATCH_REMOVED_BY_USER');
                                    }

                                    // Desatascar manual: relogin + rotar proxy entre intentos
                                    if (st.unstickRequested) {
                                        st.unstickRequested = false;
                                        try { await megaLogoutBestEffort(`UNSTICK ${bctx} asset=${aid}`); } catch {}
                                        const rotated = rotateArray(orderedBackupProxies, (Number(st.unstickRotateOffset) || 0) + 1);
                                        await megaLoginWithProxyRotationOrThrow('BACKUP', payload, rotated, `${bctx} unstick`, { maxTries: 10 });
                                    }

                                    if (attempt > 0) {
                                        console.warn(`[BATCH][BACKUP][RETRY] asset=${aid} backupAcc=${b.id} attempt=${attempt + 1}/${maxStallRetries + 1} (stall)`);
                                    }
                                    await replicateOneAssetToBackupInCurrentSession(aid, b, {
                                        onChild: (ch) => {
                                            try {
                                                st.activePutChild = ch;
                                                st.activePutLabel = ch ? `BACKUP asset=${aid} backup=${b.id}` : null;
                                            } catch {}
                                        },
                                    });
                                    break;
                                } catch (e) {
                                    const msg = String(e?.message || e || '');
                                    const wasUnstick = (Number(st.unstickToken) || 0) !== tokenBefore;
                                    const isStall = isMegaPutStallError(e) || wasUnstick;

                                    if (String(e?.message || '').includes('MEGA_BATCH_REMOVED_BY_USER')) {
                                        // Marcar réplica como failed y seguir.
                                        try {
                                            const rep = await prisma.assetReplica.findUnique({ where: { assetId_accountId: { assetId: aid, accountId: b.id } } });
                                            if (rep?.id) {
                                                await prisma.assetReplica.update({
                                                    where: { id: rep.id },
                                                    data: { status: 'FAILED', errorMessage: 'Removed from queue by user', finishedAt: new Date() },
                                                });
                                            }
                                        } catch {}
                                        break;
                                    }

                                    if (!isStall || attempt >= maxStallRetries) throw e;

                                    const rotated = rotateArray(orderedBackupProxies, attempt + 1);
                                    console.warn(`[BATCH][BACKUP][STALL] asset=${aid} backupAcc=${b.id} -> relogin + rotate proxy. err=${msg.slice(0, 200)} ${bctx}`);

                                    try { await megaLogoutBestEffort(`STALL-RETRY ${bctx} asset=${aid}`); } catch {}
                                    await megaLoginWithProxyRotationOrThrow('BACKUP', payload, rotated, `${bctx} stallRetry=${attempt + 1}`, { maxTries: 10 });
                                    const backoffMs = backoffBaseMs * Math.max(1, attempt + 1);
                                    if (backoffMs) {
                                        console.log(`[BATCH][BACKUP][STALL] backoff ${Math.round(backoffMs / 1000)}s asset=${aid} backupAcc=${b.id}`);
                                        await sleep(backoffMs);
                                    }
                                    attempt += 1;
                                }
                            }
                        } catch (e) {
                            console.error(`[BATCH][BACKUP] fail asset=${aid} backupAcc=${b.id} msg=${e.message}`);
                            replicaProgressMap.delete(`${aid}:${b.id}`);
                            try {
                                const rep = await prisma.assetReplica.findUnique({ where: { assetId_accountId: { assetId: aid, accountId: b.id } } });
                                if (rep?.id) {
                                    await prisma.assetReplica.update({
                                        where: { id: rep.id },
                                        data: { status: 'FAILED', errorMessage: e.message, finishedAt: new Date() },
                                    });
                                }
                            } catch {}
                            await notifyBatchUploadFailure({
                                phase: 'backup',
                                mainAccountId: mainId,
                                assetId: aid,
                                backupAccountId: b.id,
                                error: e?.message || e,
                                extra: bctx,
                            });
                        }
                        st.backupIndex = (Number(st.backupIndex) || 0) + 1;
                        st.currentReplicaAssetId = null;
                        st.activePutChild = null;
                        st.activePutLabel = null;
                    }

                    // Actualizar métricas de espacio del BACKUP tras replicar batch.
                    try {
                        await refreshAccountStorageFromMegaDfInCurrentSession(b.id, bctx);
                    } catch {}

                    await megaLogoutBestEffort(`POST ${bctx}`);
                }

                // Al finalizar el batch de BACKUPs, opcionalmente borrar el archivo local
                // SOLO si MAIN está ok y todas las réplicas requeridas quedaron COMPLETED.
                try {
                    for (const aid of uploadedAssetIds) {
                        await deleteLocalArchiveIfEligible(aid, {
                            requiredBackupAccountIds: eligibleBackupAccountIds,
                            ctx: `mainAccId=${mainAcc.id} backups=${eligibleBackupAccountIds.length}`,
                        });
                    }
                } catch {}

                st.phase = null;
                st.currentBackupAccountId = null;

                // Reset del flag de corte para futuros batches.
                st.cutToBackupsRequested = false;
                st.cutRequestedAt = 0;
            }, `BATCH-MAIN-${mainId}`);
        } catch (e) {
            console.error(`[BATCH] error mainAccId=${mainId} msg=${e.message}`);
            await notifyBatchUploadFailure({
                phase: 'batch',
                mainAccountId: mainId,
                assetId: '-',
                error: e?.message || e,
                extra: 'fallo general en orquestacion batch',
            });
            try {
                const stNow = megaBatchByMain.get(mainId);
                const pending = stNow ? Array.from(stNow.pending) : [];
                for (const aid of pending) {
                    try { await prisma.asset.update({ where: { id: aid }, data: { status: 'FAILED' } }); } catch {}
                }
                if (stNow) stNow.pending.clear();
            } catch {}
        } finally {
            try { stopFlag && stopFlag(); } catch {}
            st.running = false;
            st.phase = null;
            st.currentAssetId = null;
            st.currentReplicaAssetId = null;
            st.currentBackupAccountId = null;
            // Si llegaron más mientras corría y quedaron pendientes, re-disparar.
            if (st.pending.size > 0) {
                try { enqueueToMegaBatch(Array.from(st.pending)[0]); } catch {}
            }
        }
    });
}

async function ensureReplicaRowsForBatch(assetIds, backupAcc) {
    for (const assetId of assetIds) {
        await ensureReplicaRows(assetId, [backupAcc]);
    }
}

// Helper: Auto-aceptar términos de MEGA y prompts interactivos (Windows/Linux)
function attachAutoAcceptTerms(child, label = 'MEGA') {
    const EOL = '\n'; // LF: funciona en Linux y Windows
    let lastAnsweredAt = 0;
    let lastPromptAt = 0;
    let sawChoicePrompt = false;

    const ACCEPT_REGEXES = [
        /Do you accept\s+these\s+terms\??/i,
        /Do you accept.*terms\??/i,
        /Type '\s*yes\s*' to continue/i,
        /Acepta[s]? .*t[ée]rminos\??/i,
        /¿Acepta[s]? los t[ée]rminos\??/i,
    ];
    const COPYRIGHT_REGEXES = [
        /MEGA respects the copyrights/i,
        /You are strictly prohibited from using the MEGA cloud service/i,
        /copyright/i,
    ];
    const PROMPT_YNA = /Please enter \[y\]es\/\[n\]o\/\[a\]ll\/none|\[(y|Y)\]es\s*\/\s*\[(n|N)\]o\s*\/\s*\[(a|A)\]ll/i;
    const PROMPT_YN = /\[(y|Y)\]es\s*\/\s*\[(n|N)\]o/i;
    const PROMPT_ES_SN = /\[(s|S)\]\s*\/\s*\[(n|N)\]/i;

    const safeWrite = (txt, why) => {
        try {
            child.stdin.write(txt);
            lastAnsweredAt = Date.now();
            console.log(`[${label}] auto-answered (${why}) -> ${JSON.stringify(txt.trim())}`);
        } catch (err) {
            console.error(`[${label}] failed writing (${why}):`, err);
        }
    };

    const maybeAnswer = (s) => {
        const now = Date.now();
        // Construir lista de respuestas a enviar en secuencia
        const actions = [];

        if (ACCEPT_REGEXES.some((r) => r.test(s))) {
            actions.push(['yes' + EOL, 'terms']);
            lastPromptAt = now;
        }
        if (PROMPT_YNA.test(s)) {
            actions.push(['a' + EOL, 'yna']);
            lastPromptAt = now;
            sawChoicePrompt = true;
        } else if (PROMPT_YN.test(s)) {
            actions.push(['y' + EOL, 'yn']);
            lastPromptAt = now;
            sawChoicePrompt = true;
        } else if (PROMPT_ES_SN.test(s)) {
            actions.push(['s' + EOL, 'sn']);
            lastPromptAt = now;
            sawChoicePrompt = true;
        }

        if (!actions.length && COPYRIGHT_REGEXES.some((r) => r.test(s)) && /:\s*$/.test(s)) {
            // fallback genérico de EULA si termina en ':'
            actions.push(['yes' + EOL, 'fallback-eula']);
            lastPromptAt = now;
        }

        // Enviar todas las acciones con pequeños deltas para no chocar con el throttle
        actions.forEach(([txt, why], i) => {
            setTimeout(() => {
                // Anti-flood suave: si acabamos de responder < 80ms, difiere un poco más
                const since = Date.now() - lastAnsweredAt;
                if (since < 80) {
                    setTimeout(() => safeWrite(txt, why), 100 - since);
                } else {
                    safeWrite(txt, why);
                }
            }, i * 80);
        });

        // Failsafe: si vimos prompt de elección y no hubo respuesta efectiva en ~600ms, reintentar
        if (sawChoicePrompt) {
            setTimeout(() => {
                const since = Date.now() - lastAnsweredAt;
                if (since > 550) {
                    const choice = PROMPT_YNA.test(s) ? 'a' : 'y';
                    safeWrite(choice + EOL, 'failsafe-choice');
                }
            }, 600);
        }

        // Failsafe adicional tras 3s si seguimos sin respuesta
        if (!actions.length && lastPromptAt && now - lastPromptAt > 3000) {
            safeWrite('y' + EOL, 'failsafe-3s');
        }
    };

    const onData = (buf, isErr = false) => {
        const s = buf.toString();
        const trimmed = s.trim();
        if (/TRANSFERRING|Fetching nodes/i.test(trimmed)) return;
        if (isErr) console.warn(`[${label}] ${trimmed}`);
        else console.log(`[${label}] ${trimmed}`);
        maybeAnswer(s);
    };

    child.stdout.on('data', (d) => onData(d, false));
    child.stderr.on('data', (d) => onData(d, true));
}

export async function enqueueToMegaReal(asset) {
    const acc = await prisma.megaAccount.findUnique({
        where: { id: asset.accountId },
        include: { credentials: true },
    });
    if (!acc) throw new Error('Account not found');
    if (!acc.credentials) throw new Error('No credentials stored');

    // Limpieza previa (evitar acumulación de archivos temporales entre subidas)
    preUploadCleanup();
    const stopUploadsFlag = startUploadsActive(`asset:${asset.id}:main`);

    const payload = decryptToJson(
        acc.credentials.encData,
        acc.credentials.encIv,
        acc.credentials.encTag
    );
    const loginCmd = 'mega-login';
    const mkdirCmd = 'mega-mkdir';
    const putCmd = 'mega-put';
    const exportCmd = 'mega-export';
    const logoutCmd = 'mega-logout';
    const remoteBase = (acc.baseFolder || '/').replaceAll('\\', '/');
    const remotePath = path.posix.join(remoteBase, asset.slug);
    const localArchive = asset.archiveName
        ? path.join(UPLOADS_DIR, asset.archiveName)
        : null;
    // Inicio subida principal (log limpio)
    console.log(
        `[UPLOAD] Inicia subida asset=${asset.id} destino=${remotePath}`
    );

    let lastLoggedMain = -1;
    const parseProgress = (buf) => {
        const txt = buf.toString();
        let last = null;
        const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g;
        let m;
        while ((m = re.exec(txt)) !== null) last = m[1];
        if (last !== null) {
            const p = Math.max(0, Math.min(100, parseFloat(last)));
            const prev = progressMap.get(asset.id) || 0;
            if (p === 100 || p >= prev + 1) progressMap.set(asset.id, p);
            if (p === 100 || p >= lastLoggedMain + 5) {
                // cada 5%
                lastLoggedMain = p;
                console.log(`[PROGRESO] asset=${asset.id} main ${p}%`);
            }
        }
        if (/upload finished/i.test(txt)) {
            progressMap.set(asset.id, 100);
            if (lastLoggedMain !== 100)
                console.log(`[PROGRESO] asset=${asset.id} main 100%`);
        }
    };

    try {
        progressMap.set(asset.id, 0);
        await withMegaLock(async () => {
            const ctx = `accId=${acc.id} alias=${acc.alias || '--'} email=${
                acc.email || '--'
            }`;
            try {
                await runCmd(logoutCmd, []);
                console.log(`[MEGA][LOGOUT][PREV][OK] upload main ${ctx}`);
            } catch {
                console.log(`[MEGA][LOGOUT][PREV][WARN] upload main ${ctx}`);
            }
            if (payload?.type === 'session' && payload.session) {
                console.log(`[MEGA][LOGIN] main session ${ctx}`);
                await runCmd(loginCmd, [payload.session]);
            } else if (payload?.username && payload?.password) {
                console.log(`[MEGA][LOGIN] main user/pass ${ctx}`);
                await runCmd(loginCmd, [payload.username, payload.password]);
            } else throw new Error('Invalid credentials payload');
            console.log(`[MEGA][LOGIN][OK] main upload ${ctx}`);
            // Crear carpeta (ignorar si ya existe)
            await safeMkdir(remotePath);
            if (!localArchive || !fs.existsSync(localArchive))
                throw new Error('Local archive not found');
            await new Promise((resolve, reject) => {
                const child = spawn(putCmd, [localArchive, remotePath], {
                    shell: true,
                });
                attachAutoAcceptTerms(child, 'MEGA PUT');
                child.stdout.on('data', (d) => parseProgress(d));
                child.stderr.on('data', (d) => parseProgress(d));
                child.on('close', (code) =>
                    code === 0
                        ? resolve()
                        : reject(new Error(`${putCmd} exited ${code}`))
                );
            });
            // Generar link público nuevamente (requerido)
            let publicLink = null;
            try {
                const remoteFile = path.posix.join(
                    remotePath,
                    path.basename(localArchive)
                );
                const out = await new Promise((resolve, reject) => {
                    let buf = '';
                    const child = spawn(exportCmd, ['-a', remoteFile], {
                        shell: true,
                    });
                    attachAutoAcceptTerms(child, 'UPLOAD EXPORT');
                    child.stdout.on('data', (d) => (buf += d.toString()));
                    child.stderr.on('data', (d) => (buf += d.toString()));
                    child.on('close', (code) =>
                        code === 0
                            ? resolve(buf)
                            : reject(new Error('export failed'))
                    );
                });
                const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i);
                if (m) {
                    publicLink = m[0];
                    console.log(`[UPLOAD] link generado ${publicLink}`);
                }
            } catch (e) {
                console.warn('[UPLOAD] export warn:', e.message);
            }
            function stripArchivesPrefix(absPath) {
                const relFromArchives = path.relative(ARCHIVES_DIR, absPath);
                if (!relFromArchives.startsWith('..')) return relFromArchives;
                const relFromUploads = path.relative(UPLOADS_DIR, absPath);
                return relFromUploads.replace(/^archives[\\/]/i, '');
            }
            const nameWithoutPrefix = stripArchivesPrefix(localArchive);
            await prisma.asset.update({
                where: { id: asset.id },
                data: {
                    status: 'PUBLISHED',
                    archiveName: nameWithoutPrefix,
                    megaLink: publicLink || undefined,
                },
            });

            // Refrescar métricas de la cuenta MAIN en la misma sesión
            // para evitar desfase tras subidas por flujo legacy.
            try {
                await refreshAccountStorageFromMegaDfInCurrentSession(
                    acc.id,
                    `legacy-main-upload asset=${asset.id} accId=${acc.id}`
                );
            } catch {}
        }, 'MAIN-UPLOAD');
    console.log(`[UPLOAD] Finalizada asset=${asset.id} 100%`);
    } catch (e) {
    console.error('[UPLOAD] Error asset=' + asset.id + ' msg=' + e.message);
        await prisma.asset.update({
            where: { id: asset.id },
            data: { status: 'FAILED' },
        });
        throw e;
    } finally {
    progressMap.delete(asset.id);
    try { stopUploadsFlag && stopUploadsFlag() } catch{}
        try {
            await runCmd(logoutCmd, []);
            console.log(`[MEGA][LOGOUT][OK] main upload end accId=${acc.id}`);
        } catch {
            console.log(`[MEGA][LOGOUT][WARN] main upload end accId=${acc.id}`);
        }
    }

    try {
        replicateAssetToBackupsSequential(asset.id).catch((err) =>
            console.error('[REPLICA] async error:', err)
        );
    } catch (e) {
        console.error('[REPLICA] schedule error:', e.message);
    }
}

// Secuencial: toma backups relacionados al main account y replica el archivo (archiveName) creando carpeta slug
async function replicateAssetToBackupsSequential(assetId) {
    const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: {
            account: {
                include: {
                    backups: {
                        include: {
                            backupAccount: { include: { credentials: true } },
                        },
                    },
                },
            },
            replicas: true,
        },
    });
    if (!asset) return;
    if (!asset.archiveName) return; // nada que replicar
    const stopUploadsFlag = startUploadsActive(`asset:${asset.id}:replicas`);
    const archiveAbs = path.join(
        UPLOADS_DIR,
        asset.archiveName.startsWith('archives')
            ? asset.archiveName
            : path.join('archives', asset.archiveName)
    );
    // Si ya se eliminó tras subida principal no podemos replicar -> abortar
    if (!fs.existsSync(archiveAbs)) {
        console.warn('[REPLICA] local archive missing, skip replicas');
        return;
    }
    // Backups definidos para la cuenta principal
    const backupAccounts = (asset.account.backups || [])
        .map((b) => b.backupAccount)
        .filter((b) => b && b.type === 'backup');
    if (!backupAccounts.length) {
        console.log(`[REPLICA] asset=${asset.id} sin backups -> no se replica`);
        return;
    }
    console.log(
        `[REPLICA] asset=${asset.id} se replicará a ${backupAccounts.length} cuentas backup`
    );

    // Asegurar filas de replicas PENDING
    for (const b of backupAccounts) {
        try {
            await prisma.assetReplica.upsert({
                where: {
                    assetId_accountId: { assetId: asset.id, accountId: b.id },
                },
                update: {},
                create: { assetId: asset.id, accountId: b.id },
            });
        } catch (e) {
            console.warn('[REPLICA] upsert warn:', e.message);
        }
    }

    for (const b of backupAccounts) {
        let replica;
        try {
            replica = await prisma.assetReplica.findUnique({
                where: {
                    assetId_accountId: { assetId: asset.id, accountId: b.id },
                },
            });
        } catch {}
        if (!replica || replica.status !== 'PENDING') continue;
        console.log(
            `[REPLICA] start asset=${asset.id} -> backupAccount=${b.id}`
        );
        try {
            // Limpieza previa antes de cada réplica
            preUploadCleanup();
            await prisma.assetReplica.update({
                where: { id: replica.id },
                data: { status: 'PROCESSING', startedAt: new Date() },
            });
            if (!b.credentials)
                throw new Error('No credentials stored for backup');
            const payload = decryptToJson(
                b.credentials.encData,
                b.credentials.encIv,
                b.credentials.encTag
            );
            const loginCmd = 'mega-login';
            const mkdirCmd = 'mega-mkdir';
            const putCmd = 'mega-put';
            const exportCmd = 'mega-export';
            const logoutCmd = 'mega-logout';
            const remoteBase = (b.baseFolder || '/').replaceAll('\\', '/');
            const remotePath = path.posix.join(remoteBase, asset.slug);
            let publicLink = null;
            await withMegaLock(async () => {
                const rctx = `replica accId=${b.id} alias=${
                    b.alias || '--'
                } email=${b.email || '--'}`;
                try {
                    await runCmd(logoutCmd, []);
                    console.log(`[MEGA][LOGOUT][PREV][OK] ${rctx}`);
                } catch {
                    console.log(`[MEGA][LOGOUT][PREV][WARN] ${rctx}`);
                }
                if (payload?.type === 'session' && payload.session) {
                    console.log(`[MEGA][LOGIN] replica session ${rctx}`);
                    await runCmd(loginCmd, [payload.session]);
                } else if (payload?.username && payload?.password) {
                    console.log(`[MEGA][LOGIN] replica user/pass ${rctx}`);
                    await runCmd(loginCmd, [
                        payload.username,
                        payload.password,
                    ]);
                } else throw new Error('Invalid credentials');
                console.log(`[MEGA][LOGIN][OK] ${rctx}`);
                await safeMkdir(remotePath);
                const fileName = path.basename(archiveAbs);
                const stallTimeoutMs = Number(process.env.MEGA_REPLICA_STALL_TIMEOUT_MS) || 5 * 60 * 1000;
                await megaPutWithProgressAndStall({
                    srcPath: archiveAbs,
                    remotePath,
                    progressKey: `${asset.id}:${b.id}`,
                    logPrefix: `asset=${asset.id} backup=${b.id}`,
                    stallTimeoutMs,
                });
                try {
                    const remoteFile = path.posix.join(remotePath, fileName);
                    const out = await new Promise((resolve, reject) => {
                        let buf = '';
                        const child = spawn(exportCmd, ['-a', remoteFile], {
                            shell: true,
                        });
                        attachAutoAcceptTerms(child, 'REPLICA EXPORT');
                        child.stdout.on('data', (d) => (buf += d.toString()));
                        child.stderr.on('data', (d) => (buf += d.toString()));
                        child.on('close', (code) =>
                            code === 0
                                ? resolve(buf)
                                : reject(new Error('export failed'))
                        );
                    });
                    const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i);
                    if (m) publicLink = m[0];
                } catch (e) {
                    console.warn('[REPLICA] export warn:', e.message);
                }
                try {
                    await runCmd(logoutCmd, []);
                    console.log(`[MEGA][LOGOUT][OK] replica accId=${b.id}`);
                } catch {
                    console.log(`[MEGA][LOGOUT][WARN] replica accId=${b.id}`);
                }

                // Refrescar métricas del BACKUP en la misma sesión
                // luego de cada réplica subida por flujo legacy.
                try {
                    await refreshAccountStorageFromMegaDfInCurrentSession(
                        b.id,
                        `legacy-backup-upload asset=${asset.id} backupAccId=${b.id}`
                    );
                } catch {}
            }, `REPLICA-${b.id}`);
            replicaProgressMap.set(`${asset.id}:${b.id}`, 100);
            await prisma.assetReplica.update({
                where: { id: replica.id },
                data: {
                    status: 'COMPLETED',
                    finishedAt: new Date(),
                    megaLink: publicLink || undefined,
                    remotePath,
                },
            });
            console.log(
                `[REPLICA] completed asset=${asset.id} backupAccount=${b.id}`
            );
        } catch (err) {
            console.error('[REPLICA] error backupAccount=' + b.id, err);
            try {
                await prisma.assetReplica.update({
                    where: { id: replica.id },
                    data: {
                        status: 'FAILED',
                        errorMessage: err.message,
                        finishedAt: new Date(),
                    },
                });
            } catch {}
            replicaProgressMap.delete(`${asset.id}:${b.id}`);
        }
        // Limpieza de progreso en memoria si ya terminó (COMPLETED o FAILED)
        try {
            const r = await prisma.assetReplica.findUnique({
                where: { id: replica.id },
                select: { status: true, accountId: true },
            });
            if (r && (r.status === 'COMPLETED' || r.status === 'FAILED'))
                replicaProgressMap.delete(`${asset.id}:${r.accountId}`);
        } catch {}
    }

    // Cuando todas finalizan (o fallan) eliminar archivo local (si existe)
    try {
        const remainProcessing = await prisma.assetReplica.count({
            where: {
                assetId: asset.id,
                status: { in: ['PENDING', 'PROCESSING'] },
            },
        });
        if (remainProcessing === 0 && fs.existsSync(archiveAbs)) {
            try {
                fs.unlinkSync(archiveAbs);
            } catch {}
            try {
                removeEmptyDirsUp(path.dirname(archiveAbs), ARCHIVES_DIR);
            } catch {}
        }
    } catch {}
    // Limpiar progresos restantes del asset
    for (const key of Array.from(replicaProgressMap.keys()))
        if (key.startsWith(`${asset.id}:`)) replicaProgressMap.delete(key);
    try { stopUploadsFlag && stopUploadsFlag() } catch{}
}

// Endpoint para listar réplicas de un asset
export const listAssetReplicas = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const rows = await prisma.assetReplica.findMany({
            where: { assetId: id },
            include: { account: { select: { id: true, alias: true } } },
            orderBy: { id: 'asc' },
        });
        const enriched = rows.map((r) => ({
            ...r,
            progress:
                replicaProgressMap.get(`${id}:${r.accountId}`) ??
                (r.status === 'COMPLETED'
                    ? 100
                    : r.status === 'PROCESSING'
                    ? 0
                    : 0),
        }));
        return res.json(enriched);
    } catch (e) {
        return res.status(500).json({ message: 'Error listing replicas' });
    }
};

// Progreso completo (principal + replicas)
export const getFullProgress = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const asset = await prisma.asset.findUnique({
            where: { id },
            select: { status: true, accountId: true },
        });
        if (!asset) return res.status(404).json({ message: 'Not found' });
        let expectedReplicas = [];
        try {
            const links = await prisma.megaAccountBackup.findMany({
                where: { mainAccountId: asset.accountId },
                include: {
                    backupAccount: {
                        select: { id: true, alias: true, type: true },
                    },
                },
            });
            expectedReplicas = links
                .map((l) => l.backupAccount)
                .filter((b) => b && b.type === 'backup')
                .map((b) => ({ accountId: b.id, alias: b.alias }));
        } catch (err) {
            console.warn('[ASSETS] expectedReplicas warn:', err.message);
        }
        const mainProgress =
            progressMap.get(id) ?? (asset.status === 'PUBLISHED' ? 100 : 0);
        const replicasDb = await prisma.assetReplica.findMany({
            where: { assetId: id },
            include: { account: { select: { id: true, alias: true } } },
        });
        const replicaMap = new Map(replicasDb.map((r) => [r.accountId, r]));
        let replicaItems;
        if (expectedReplicas.length) {
            replicaItems = expectedReplicas.map((exp) => {
                const r = replicaMap.get(exp.accountId);
                if (r) {
                    const inMem = replicaProgressMap.get(
                        `${id}:${r.accountId}`
                    );
                    let p = inMem ?? (r.status === 'COMPLETED' ? 100 : 0);
                    if (r.status === 'FAILED') p = 100;
                    return {
                        id: r.id,
                        accountId: r.accountId,
                        alias: r.account.alias,
                        status: r.status,
                        progress: p,
                    };
                }
                return {
                    id: null,
                    accountId: exp.accountId,
                    alias: exp.alias,
                    status: 'PENDING',
                    progress: 0,
                };
            });
        } else {
            // fallback: no expected list, use whatever exists
            replicaItems = replicasDb.map((r) => {
                const inMem = replicaProgressMap.get(`${id}:${r.accountId}`);
                let p = inMem ?? (r.status === 'COMPLETED' ? 100 : 0);
                if (r.status === 'FAILED') p = 100;
                return {
                    id: r.id,
                    accountId: r.accountId,
                    alias: r.account.alias,
                    status: r.status,
                    progress: p,
                };
            });
        }
        const totalTargets = 1 + replicaItems.length;
        const perTarget = [
            mainProgress,
            ...replicaItems.map((r) => r.progress),
        ];
        const overallPercent = perTarget.length
            ? Math.round(
                  perTarget.reduce((a, b) => a + b, 0) / perTarget.length
              )
            : mainProgress;
        let allDone;
        if (!replicaItems.length) {
            allDone = asset.status === 'PUBLISHED' || asset.status === 'FAILED';
        } else {
            const replicasFinished = replicaItems.every((r) =>
                ['COMPLETED', 'FAILED'].includes(r.status)
            );
            // sólo done si todas las esperadas están (placeholder id null no bloquea) y terminaron
            const haveAll =
                replicaItems.filter((r) => r.status !== 'PENDING').length ===
                    expectedReplicas.length || expectedReplicas.length === 0;
            allDone =
                (asset.status === 'PUBLISHED' || asset.status === 'FAILED') &&
                replicasFinished &&
                haveAll;
        }
        const batch = getBatchInfoForAsset(id, asset.accountId);
        return res.json({
            main: { status: asset.status, progress: mainProgress },
            replicas: replicaItems,
            totalTargets,
            overallPercent,
            allDone,
            expectedReplicas,
            batch,
        });
    } catch (e) {
        console.error('[ASSETS] fullProgress error:', e);
        return res.status(500).json({ message: 'Error getting full progress' });
    }
};

// DELETE /api/assets/:id
export const deleteAsset = async (req, res) => {
    const id = Number(req.params.id);
    try {
        const asset = await prisma.asset.findUnique({
            where: { id },
            include: {
                account: { include: { credentials: true } },
                replicas: {
                    include: { account: { include: { credentials: true } } },
                },
            },
        });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        qdrantService.deleteAssetVector(id).catch(err => console.error('[QDRANT] Delete error:', err));

        const imgDir = path.join(IMAGES_DIR, asset.slug); // imágenes por slug
        const archDir = path.join(ARCHIVES_DIR, asset.slug); // archivo por slug

        // Borrar archivos locales (imágenes, thumbs y archivo)
        try {
            if (fs.existsSync(imgDir))
                fs.rmSync(imgDir, { recursive: true, force: true });
        } catch (e) {
            console.warn('[ASSETS] rm images warn:', e.message);
        }
        // Fallback: si la carpeta no se borró, intentar borrar por archivo según asset.images
        try {
            if (fs.existsSync(imgDir)) {
                const imgs = Array.isArray(asset.images) ? asset.images : [];
                for (const rel of imgs) {
                    try {
                        const abs = path.join(UPLOADS_DIR, rel);
                        if (fs.existsSync(abs)) fs.unlinkSync(abs);
                        // Intentar limpiar directorios vacíos bajo images
                        try { removeEmptyDirsUp(path.dirname(abs), IMAGES_DIR) } catch {}
                    } catch {}
                }
                // Intentar nuevamente eliminar el directorio del slug
                try { if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true }) } catch {}
            }
        } catch {}
        try {
            if (fs.existsSync(archDir))
                fs.rmSync(archDir, { recursive: true, force: true });
        } catch (e) {
            console.warn('[ASSETS] rm archives warn:', e.message);
        }
        try {
            removeEmptyDirsUp(path.dirname(imgDir), IMAGES_DIR);
        } catch {}
        try {
            removeEmptyDirsUp(path.dirname(archDir), ARCHIVES_DIR);
        } catch {}

        // Recolectar cuentas a borrar: principal + backups (de replicas existentes)
        const accountsToDelete = [];
        if (asset.account && asset.account.credentials)
            accountsToDelete.push({ kind: 'main', acc: asset.account });
        const backupSeen = new Set();
        for (const r of asset.replicas || []) {
            if (
                r.account &&
                r.account.credentials &&
                !backupSeen.has(r.account.id)
            ) {
                backupSeen.add(r.account.id);
                accountsToDelete.push({ kind: 'backup', acc: r.account });
            }
        }

        const rmCmd = 'mega-rm';
        const proxies = listMegaProxies({});
        if (!proxies.length) {
            return res.status(503).json({
                message:
                    'No hay proxies MEGA disponibles. La eliminación remota requiere proxy (no se permite IP directa).',
            });
        }

        const results = [];
        for (const entry of accountsToDelete) {
            const { acc } = entry;
            let deleted = false;
            let proxyUsed = null;
            try {
                const payload = decryptToJson(
                    acc.credentials.encData,
                    acc.credentials.encIv,
                    acc.credentials.encTag
                );
                const remoteBase = (acc.baseFolder || '/').replaceAll(
                    '\\',
                    '/'
                );
                const remotePath = path.posix.join(remoteBase, asset.slug);
                await withMegaLock(async () => {
                    const ctx = `[DEL][asset=${id}][acc=${acc.id}:${acc.alias || '--'}]`;
                    const picked = await applyAnyWorkingProxyOrThrow(
                        'delete',
                        proxies,
                        ctx,
                        10
                    );
                    proxyUsed = picked?.proxyUrl || null;
                    await megaLogoutBestEffort(`PREV ${ctx}`);
                    await megaLoginOrThrow(payload, ctx);
                    try {
                        console.log(`[ASSETS][DEL][MEGA-RM][START] acc=${acc.id} path=${remotePath} proxy=${proxyUsed || '--'} ${ctx}`);
                        await runCmd(rmCmd, ['-rf', remotePath]);
                        deleted = true;
                        console.log(`[ASSETS][DEL][MEGA-RM][OK] acc=${acc.id} path=${remotePath} ${ctx}`);
                    } catch (e) {
                        console.warn(
                            `[ASSETS][DEL][MEGA-RM][WARN] acc=${acc.id} path=${remotePath}:`,
                            e.message
                        );
                    }

                    // Refrescar storage de la cuenta en la misma sesión antes de logout.
                    // Evita desincronización tras borrar desde Assets/Similares.
                    try {
                        await refreshAccountStorageFromMegaDfInCurrentSession(
                            acc.id,
                            `${ctx} phase=delete`
                        );
                    } catch {}

                    await megaLogoutBestEffort(`POST ${ctx}`);
                }, `DEL-${acc.id}`);
            } catch (e) {
                console.warn(
                    '[ASSETS] mega delete warn acc=' + acc.id,
                    e.message
                );
            }
            results.push({
                accountId: acc.id,
                kind: entry.kind,
                deleted,
                proxyUsed,
            });
        }

        // Eliminar de DB (asset + replicas cascada si FK ON DELETE CASCADE)
        await prisma.asset.delete({ where: { id } });

        const mainResult = results.find((r) => r.kind === 'main');
        return res.json({
            dbDeleted: true,
            megaDeleted: mainResult?.deleted || false,
            results,
        });
    } catch (e) {
        console.error('[ASSETS] delete error:', e);
        return res.status(500).json({ message: 'Error deleting asset' });
    }
};

// Obtener últimas N novedades (publicadas)
export const latestAssets = async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
        const items = await prisma.asset.findMany({
            where: { status: 'PUBLISHED' },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit,
            select: {
                id: true,
                slug: true,
                title: true,
                titleEn: true,
                description: true,
                descriptionEn: true,
                images: true,
                isPremium: true,
                createdAt: true,
                categories: {
                    select: {
                        id: true,
                        name: true,
                        nameEn: true,
                        slug: true,
                        slugEn: true,
                    },
                },
                tags: { select: { slug: true, name: true, nameEn: true } },
            },
        });

        const enriched = items.map((it) => {
            const tagsEs = Array.isArray(it.tags)
                ? it.tags.map((t) => t.slug)
                : [];
            const tagsEn = Array.isArray(it.tags)
                ? it.tags.map((t) => t.nameEn || t.name || t.slug)
                : [];
            return { ...it, tagsEs, tagsEn };
        });

        return res.json(enriched);
    } catch (e) {
        console.error('[ASSETS] latest error:', e);
        return res.status(500).json({ message: 'Error getting latest assets' });
    }
};

// Obtener más descargados (publicados)
export const mostDownloadedAssets = async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
        const items = await prisma.asset.findMany({
            where: { status: 'PUBLISHED' },
            orderBy: [{ downloads: 'desc' }, { id: 'desc' }],
            take: limit,
            select: {
                id: true,
                slug: true,
                title: true,
                titleEn: true,
                images: true,
                isPremium: true,
                downloads: true,
                createdAt: true,
                categories: {
                    select: {
                        id: true,
                        name: true,
                        nameEn: true,
                        slug: true,
                        slugEn: true,
                    },
                },
                tags: { select: { slug: true, name: true, nameEn: true } },
            },
        });

        const enriched = items.map((it) => {
            const tagsEs = Array.isArray(it.tags)
                ? it.tags.map((t) => t.slug)
                : [];
            const tagsEn = Array.isArray(it.tags)
                ? it.tags.map((t) => t.nameEn || t.name || t.slug)
                : [];
            return { ...it, tagsEs, tagsEn };
        });

        return res.json(enriched);
    } catch (e) {
        console.error('[ASSETS] mostDownloaded error:', e);
        return res
            .status(500)
            .json({ message: 'Error getting most downloaded assets' });
    }
};

// Búsqueda pública con filtros por categorías, tags y texto libre
// export const searchAssets = async (req, res) => {
//     try {
//         const {
//             q = '',
//             categories = '',
//             tags = '',
//             order = '',
//             plan,
//             isPremium,
//             pageIndex,
//             pageSize,
//         } = req.query || {};

//         const qStr = String(q || '').trim();
//         const qLower = qStr.toLowerCase();
//         const qSlug = qLower.replace(/[^a-z0-9-_]+/g, '-');

//         // Paginación (zero-based)
//         let page = Number.isFinite(Number(pageIndex)) ? Number(pageIndex) : 0;
//         if (!Number.isFinite(page) || page < 0) page = 0;
//         let size = Number.isFinite(Number(pageSize)) ? Number(pageSize) : 24;
//         if (!Number.isFinite(size) || size <= 0) size = 24;
//         // límites razonables para evitar respuestas gigantes
//         if (size > 96) size = 96;

//         const catListRaw = String(categories || '')
//             .split(',')
//             .map((s) => s.trim())
//             .filter(Boolean);
//         const catList = catListRaw.map((s) => safeName(s));

//         const tagTokens = String(tags || '')
//             .split(',')
//             .map((s) => s.trim().toLowerCase())
//             .filter(Boolean);

//         let resolvedTagSlugsSet = new Set();
//         if (tagTokens.length) {
//             try {
//                 const rows = await prisma.tag.findMany({
//                     where: {
//                         OR: [
//                             { slug: { in: tagTokens } },
//                             { slugEn: { in: tagTokens } },
//                         ],
//                     },
//                     select: { slug: true },
//                 });
//                 for (const r of rows)
//                     resolvedTagSlugsSet.add(String(r.slug).toLowerCase());
//                 for (const t of tagTokens) resolvedTagSlugsSet.add(t);
//             } catch (e) {
//                 resolvedTagSlugsSet = new Set(tagTokens);
//             }
//         }

//         const where = { status: 'PUBLISHED' };
//         // Filtro por plan o isPremium: plan=free|premium o isPremium=true|false
//         const planStr = String(plan || '').toLowerCase();
//         if (planStr === 'free') where.isPremium = false;
//         else if (planStr === 'premium') where.isPremium = true;
//         if (isPremium !== undefined && String(isPremium).length) {
//             const b = String(isPremium).toLowerCase();
//             if (b === 'true') where.isPremium = true;
//             if (b === 'false') where.isPremium = false;
//         }

//         const andArr = [];
//         if (catList.length) {
//             andArr.push({
//                 OR: [
//                     { categories: { some: { slug: { in: catList } } } },
//                     { categories: { some: { slugEn: { in: catList } } } },
//                 ],
//             });
//         }
//         const tagList = Array.from(resolvedTagSlugsSet);
//         if (tagList.length) {
//             andArr.push({ tags: { some: { slug: { in: tagList } } } });
//         }
//         if (andArr.length) where.AND = andArr;

//         const baseSelect = {
//             id: true,
//             slug: true,
//             title: true,
//             titleEn: true,
//             images: true,
//             isPremium: true,
//             downloads: true,
//             createdAt: true,
//             categories: {
//                 select: {
//                     id: true,
//                     name: true,
//                     nameEn: true,
//                     slug: true,
//                     slugEn: true,
//                 },
//             },
//             tags: {
//                 select: {
//                     slug: true,
//                     slugEn: true,
//                     name: true,
//                     nameEn: true,
//                 },
//             },
//         };

//         const orderBy =
//             String(order).toLowerCase() === 'downloads'
//                 ? [{ downloads: 'desc' }, { id: 'desc' }]
//                 : { id: 'desc' };

//         let itemsDb;
//         let total = 0;
//         if (!qLower) {
//             // Caso simple: sin término de búsqueda. Usamos count + skip/take para total real y página exacta.
//             total = await prisma.asset.count({ where });
//             itemsDb = await prisma.asset.findMany({
//                 where,
//                 orderBy,
//                 skip: page * size,
//                 take: size,
//                 select: baseSelect,
//             });
//         } else {
//             // Caso con búsqueda: traemos un universo acotado y luego puntuamos en memoria.
//             itemsDb = await prisma.asset.findMany({
//                 where,
//                 orderBy,
//                 take: 1000,
//                 select: baseSelect,
//             });
//         }

//         const scored = [];
//         for (const it of itemsDb) {
//             if (!qLower) {
//                 scored.push({ it, score: 0 });
//                 continue;
//             }

//             const title = String(it.title || '');
//             const titleEn = String(it.titleEn || '');
//             const descr = String(it.description || '');
//             const arch = String(it.archiveName || '');
//             const imgs = Array.isArray(it.images) ? it.images : [];

//             const tagsArr = Array.isArray(it.tags) ? it.tags : [];
//             const catsArr = Array.isArray(it.categories) ? it.categories : [];

//             const titleL = title.toLowerCase();
//             const titleEnL = titleEn.toLowerCase();
//             const descrL = descr.toLowerCase();
//             const archL = arch.toLowerCase();
//             const imgsL = imgs.map((p) => String(p).toLowerCase());

//             const tagsTexts = tagsArr.flatMap((t) =>
//                 [t.slug, t.slugEn, t.name, t.nameEn].filter(Boolean).map(String)
//             );
//             const catsTexts = catsArr.flatMap((c) =>
//                 [c.slug, c.slugEn, c.name, c.nameEn].filter(Boolean).map(String)
//             );
//             const tagsL = tagsTexts.map((x) => x.toLowerCase());
//             const catsL = catsTexts.map((x) => x.toLowerCase());

//             let score = 0;
//             if (titleL.includes(qLower)) score += 120;
//             if (titleEnL.includes(qLower)) score += 115;
//             if (archL && archL.includes(qLower)) score += 90;
//             if (imgsL.some((p) => p.includes(qLower))) score += 85;
//             if (tagsL.some((t) => t.includes(qLower))) score += 75;
//             if (catsL.some((c) => c.includes(qLower))) score += 55;
//             if (descrL.includes(qLower)) score += 35;
//             if (titleL.startsWith(qLower) || titleEnL.startsWith(qLower))
//                 score += 10;

//             if (score > 0) scored.push({ it, score });
//         }

//         if (qLower) {
//             scored.sort((a, b) => b.score - a.score || b.it.id - a.it.id);
//         } else if (String(order).toLowerCase() === 'downloads') {
//             scored.sort(
//                 (a, b) => b.it.downloads - a.it.downloads || b.it.id - a.it.id
//             );
//         }

//         let out = [];
//         let hasMore = false;
//         if (qLower) {
//             // Lista completa en memoria (máximo 1000 por consulta a DB)
//             const outFull = scored.map(({ it }) => it);
//             total = outFull.length; // total = coincidencias
//             const start = page * size;
//             const end = start + size;
//             out = start < total ? outFull.slice(start, end) : [];
//             hasMore = end < total;
//         } else {
//             // Ya paginado con skip/take en la consulta
//             out = itemsDb;
//             hasMore = (page + 1) * size < total;
//         }

//         const enriched = out.map((it) => {
//             const rest = { ...it };
//             delete rest.megaLink;
//             const tagsEs = Array.isArray(it.tags)
//                 ? it.tags.map((t) => t.slug)
//                 : [];
//             const tagsEn = Array.isArray(it.tags)
//                 ? it.tags.map((t) => t.nameEn || t.name || t.slug)
//                 : [];
//             return { ...rest, tagsEs, tagsEn };
//         });

//     return res.json({ items: enriched, total, page, pageSize: size, hasMore });
//     } catch (e) {
//         console.error('[ASSETS] search error:', e);
//         return res.status(500).json({ message: 'Error searching assets' });
//     }
// };


export const searchAssets = async (req, res) => {
  try {
    const {
      q = '',
      categories = '',
      tags = '',
      pageIndex,
      pageSize,
      // opcionales (si quieres mantenerlos)
      plan,
      isPremium,
            is_ai_search,
      order // ignorado a propósito: siempre latest-first
    } = req.query || {};

    // --- Paginación (zero-based) ---
    let page = Number.isFinite(Number(pageIndex)) ? Number(pageIndex) : 0;
    if (!Number.isFinite(page) || page < 0) page = 0;

    let size = Number.isFinite(Number(pageSize)) ? Number(pageSize) : 24;
    if (!Number.isFinite(size) || size <= 0) size = 24;
    if (size > 96) size = 96;

    // --- Texto libre: minúsculas para consistencia ---
    const qStr = String(q || '').trim();
    const qLower = qStr.toLowerCase();
        const isAiSearch = String(is_ai_search || '').toLowerCase() === 'true';

        // IA sin frase: no debe devolver resultados.
        if (isAiSearch && !qStr) {
            return res.json({ items: [], total: 0, page, pageSize: size, hasMore: false });
        }

    // --- Listas de categorías y tags ---
    const catList = String(categories || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => safeName(s));

    const tagTokens = String(tags || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    // Resolver tags por slug y slugEn (case-insensitive)
    let resolvedTagSlugs = [];
    if (tagTokens.length) {
      try {
        const rows = await prisma.tag.findMany({
          where: {
            OR: [
              { slug: { in: tagTokens } },
              { slugEn: { in: tagTokens } },
            ],
          },
          select: { slug: true, slugEn: true },
        });
        const set = new Set(tagTokens);
        for (const r of rows) {
          if (r.slug) set.add(String(r.slug).toLowerCase());
          if (r.slugEn) set.add(String(r.slugEn).toLowerCase());
        }
        resolvedTagSlugs = Array.from(set);
      } catch {
        resolvedTagSlugs = tagTokens;
      }
    }

    // --- WHERE base ---
    const where = { status: 'PUBLISHED' };

    // Opcional: plan/isPremium (se respeta si lo usas en el front)
    const planStr = String(plan || '').toLowerCase();
    if (planStr === 'free') where.isPremium = false;
    else if (planStr === 'premium') where.isPremium = true;

    if (isPremium !== undefined && String(isPremium).length) {
      const b = String(isPremium).toLowerCase();
      if (b === 'true') where.isPremium = true;
      if (b === 'false') where.isPremium = false;
    }

    const andArr = [];

    // Filtro por categorías: acepta slug y slugEn
    if (catList.length) {
      andArr.push({
        OR: [
          { categories: { some: { slug:   { in: catList } } } },
          { categories: { some: { slugEn: { in: catList } } } },
        ],
      });
    }

    // Filtro por tags: acepta slug y slugEn
    if (resolvedTagSlugs.length) {
      andArr.push({
        OR: [
          { tags: { some: { slug:   { in: resolvedTagSlugs } } } },
          { tags: { some: { slugEn: { in: resolvedTagSlugs } } } },
        ],
      });
    }

    // Para búsquedas con q: no añadimos una sola condición OR aquí.
    // En su lugar haremos 3 consultas separadas (títulos -> tags -> categorías)
    // y las concatenaremos en ese orden, eliminando duplicados, para garantizar
    // que los resultados aparezcan primero por nombre, luego por tags y al final
    // por categorías. Si qLower no existe mantendremos la paginación normal.

    if (andArr.length) where.AND = andArr;

    // --- SELECT mínimo necesario + relaciones ---
    const select = {
      id: true,
      slug: true,
      title: true,
      titleEn: true,
            description: true,
            descriptionEn: true,
      images: true,
      isPremium: true,
      downloads: true,
      createdAt: true,
      archiveName: true,

      categories: {
        select: {
          id: true,
          name: true,
          nameEn: true,
          slug: true,
          slugEn: true,
        },
      },
      tags: {
        select: {
          slug: true,
          slugEn: true,
          name: true,
          nameEn: true,
        },
      },
    };

    // --- ORDEN: siempre los últimos subidos primero ---
    const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];

        // --- Búsqueda IA semántica (Qdrant) ---
        if (isAiSearch && qLower) {
            const AI_MEM_LIMIT = 1500;
            const AI_MIN_RESULTS = 200;
            const aiLimit = Math.min(
                AI_MEM_LIMIT,
                Math.max(AI_MIN_RESULTS, (page + 1) * size * 3)
            );

            const aiResults = await qdrantService.searchSimilarAssets(qStr, aiLimit);
            const aiIdsOrdered = [];
            const aiSeen = new Set();

            for (const hit of aiResults || []) {
                const id = Number(hit?.id);
                if (!Number.isFinite(id) || id <= 0 || aiSeen.has(id)) continue;
                aiSeen.add(id);
                aiIdsOrdered.push(id);
                if (aiIdsOrdered.length >= AI_MEM_LIMIT) break;
            }

            if (!aiIdsOrdered.length) {
                return res.json({ items: [], total: 0, page, pageSize: size, hasMore: false });
            }

            const aiWhere = {
                ...where,
                id: { in: aiIdsOrdered },
            };

            const aiItemsDb = await prisma.asset.findMany({
                where: aiWhere,
                select,
            });

            const aiById = new Map(aiItemsDb.map((it) => [Number(it.id), it]));
            const orderedBySimilarity = [];
            for (const id of aiIdsOrdered) {
                const row = aiById.get(id);
                if (row) orderedBySimilarity.push(row);
            }

            const total = orderedBySimilarity.length;
            const start = page * size;
            const end = start + size;
            const out = start < total ? orderedBySimilarity.slice(start, end) : [];
            const hasMore = end < total;

            const items = out.map((it) => {
                const { ...rest } = it;
                const tagsEs = Array.isArray(it.tags) ? it.tags.map((t) => t.slug) : [];
                const tagsEn = Array.isArray(it.tags)
                    ? it.tags.map((t) => t.nameEn || t.name || t.slug)
                    : [];
                return { ...rest, tagsEs, tagsEn };
            });

            return res.json({ items, total, page, pageSize: size, hasMore });
        }

        // --- total + página ---
        if (!qLower) {
            // Sin texto de búsqueda: paginación normal en DB
            const total = await prisma.asset.count({ where });
            const itemsDb = await prisma.asset.findMany({
                where,
                orderBy,
                skip: page * size,
                take: size,
                select,
            });

            // --- Enriquecimiento de salida ---
            const items = itemsDb.map((it) => {
                const {
                    // ocultar megaLink si está en el modelo fuera del select
                    // megaLink,  // no se selecciona
                    ...rest
                } = it;

                const tagsEs = Array.isArray(it.tags) ? it.tags.map((t) => t.slug) : [];
                const tagsEn = Array.isArray(it.tags)
                    ? it.tags.map((t) => t.nameEn || t.name || t.slug)
                    : [];

                return { ...rest, tagsEs, tagsEn };
            });

            const hasMore = (page + 1) * size < total;

            return res.json({ items, total, page, pageSize: size, hasMore });
        }

        // Rama para qLower: realizar 3 consultas separadas y concatenar
        // 1) coincidencias por título/archiveName
        // 2) coincidencias por tags
        // 3) coincidencias por categories
        // Además calculamos `total` con un count que engloba las 3 condiciones.

        // Condiciones específicas
        const titleCond = {
            OR: [
                { title: { contains: qStr } },
                { titleEn: { contains: qStr } },
                { archiveName: { contains: qStr } },
            ],
        };

        const tagsCond = {
            tags: {
                some: {
                    OR: [
                        { slug: { contains: qStr } },
                        { slugEn: { contains: qStr } },
                        { name: { contains: qStr } },
                        { nameEn: { contains: qStr } },
                    ],
                },
            },
        };

        const catsCond = {
            categories: {
                some: {
                    OR: [
                        { slug: { contains: qStr } },
                        { slugEn: { contains: qStr } },
                        { name: { contains: qStr } },
                        { nameEn: { contains: qStr } },
                    ],
                },
            },
        };

        // count total de coincidencias únicas (DB)
        const matchAnyWhere = { ...where };
        // asegurarnos de mantener AND existente
        matchAnyWhere.AND = Array.isArray(matchAnyWhere.AND) ? [...matchAnyWhere.AND] : [];
        matchAnyWhere.AND.push({ OR: [titleCond, tagsCond, catsCond] });

        const total = await prisma.asset.count({ where: matchAnyWhere });

        // límite razonable en memoria (igual que antes)
        const MEM_LIMIT = 1000;

        // Ejecutar 3 consultas separadas manteniendo orden por createdAt desc
        const titleItems = await prisma.asset.findMany({ where: { ...where, AND: [...(where.AND || []), titleCond] }, orderBy, take: MEM_LIMIT, select });
        const tagItems = await prisma.asset.findMany({ where: { ...where, AND: [...(where.AND || []), tagsCond] }, orderBy, take: MEM_LIMIT, select });
        const catItems = await prisma.asset.findMany({ where: { ...where, AND: [...(where.AND || []), catsCond] }, orderBy, take: MEM_LIMIT, select });

        // Concatenar en el orden deseado y eliminar duplicados
        const seen = new Set();
        const combined = [];
        for (const it of titleItems) {
            if (!seen.has(it.id)) {
                seen.add(it.id);
                combined.push(it);
            }
        }
        for (const it of tagItems) {
            if (!seen.has(it.id)) {
                seen.add(it.id);
                combined.push(it);
            }
        }
        for (const it of catItems) {
            if (!seen.has(it.id)) {
                seen.add(it.id);
                combined.push(it);
            }
        }

        // Paginación en memoria sobre la lista combinada
        const start = page * size;
        const end = start + size;
        const outFull = combined.slice(0, MEM_LIMIT); // respetar límite
        const out = start < outFull.length ? outFull.slice(start, end) : [];
        const hasMore = end < combined.length;

        const items = out.map((it) => {
            const { ...rest } = it;
            const tagsEs = Array.isArray(it.tags) ? it.tags.map((t) => t.slug) : [];
            const tagsEn = Array.isArray(it.tags) ? it.tags.map((t) => t.nameEn || t.name || t.slug) : [];
            return { ...rest, tagsEs, tagsEn };
        });

        return res.json({ items, total, page, pageSize: size, hasMore });

        // (la lógica de respuesta ya fue manejada en las ramas anteriores)
  } catch (e) {
    console.error('[ASSETS] search error:', e);
    return res.status(500).json({ message: 'Error searching assets' });
  }
};



// Solicitud de descarga (segura)
export const requestDownload = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid asset id' });
    }

    // 1) Cargar asset primero (fail-fast)
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, status: true, isPremium: true, megaLink: true, megaLinkAlive: true , megaLinkCheckedAt: true, title: true },
    });

    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    if (asset.status !== 'PUBLISHED') {
      return res.status(409).json({ message: 'Asset not available' });
    }
    if (!asset.megaLink) {
      return res.status(409).json({ message: 'Download link not ready' });
    }

    // 2) Extraer token una sola vez (prioriza Authorization)
    const auth = req.headers.authorization || '';
    const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    // ⚠️ Compatibilidad: aceptar token por body/query (recomendado quitar en el futuro)
    const legacyToken = req.body?.token || req.query?.token || null;

    const tokenToUse = bearerToken || legacyToken || null;

    let userId = null;
    let roleId = null;
    let jwtVerFromToken = null;

    if (tokenToUse) {
      try {
        const secret = process.env.JWT_SECRET || 'dev-secret';
        const payload = jwt.verify(tokenToUse, secret); // lanza si inválido/expirado
        userId = Number(payload?.id) || null;
        roleId = Number(payload?.roleId) || null;
        // Si firmas el token con jwtVersion, esto te permite invalidar tokens antiguos
        jwtVerFromToken = payload?.jwtVersion != null ? Number(payload.jwtVersion) : null;
      } catch {
        // Token inválido/expirado -> 401
        return res.status(401).json({ message: 'Unauthorized' });
      }
    }

    // 3) Política Free vs Premium
    let allowed = false;

    if (!asset.isPremium) {
      // Free: permitido sin autenticación
      allowed = true;
    } else {
      // Premium: requiere autenticación
      if (!tokenToUse || !userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // 3.1) Verificar usuario activo + (opcional) invalidación por jwtVersion
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { isActive: true, jwtVersion: true },
      });
      if (!user || !user.isActive) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      if (jwtVerFromToken != null && user.jwtVersion != null && jwtVerFromToken !== user.jwtVersion) {
        // El token pertenece a una versión antigua -> inválido
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // 3.2) Admin bypass
      if (roleId === 2) {
        allowed = true;
      } else {
        // 3.3) Auditar la suscripción más reciente
        const now = new Date();
        const lastSub = await prisma.subscription.findFirst({
          where: { userId },
          orderBy: { currentPeriodEnd: 'desc' },
        });

        if (!lastSub) {
          return res.status(403).json({ code: 'NO_SUB', message: 'Subscription required' });
        }

        let currentStatus = lastSub.status;

        // Si está ACTIVE pero ya venció, marcar EXPIRED primero
        if (currentStatus === 'ACTIVE' && lastSub.currentPeriodEnd < now) {
          await prisma.subscription.update({
            where: { id: lastSub.id },
            data: { status: 'EXPIRED' },
          });
          currentStatus = 'EXPIRED';
        }

        const isActive = currentStatus === 'ACTIVE' && lastSub.currentPeriodEnd > now;
        if (!isActive) {
          return res.status(403).json({
            code: 'EXPIRED',
            message: 'Subscription expired',
            expiredAt: lastSub.currentPeriodEnd.toISOString(),
          });
        }

        allowed = true;
      }
    }

    if (!allowed) {
      // En teoría no llegamos acá (todas las rutas ajustan allowed),
      // pero lo dejamos por seguridad.
      return res.status(403).json({ message: 'Forbidden' });
    }

    // 4) Verificar disponibilidad del link de MEGA (antes de contar descarga)
    maybeCheckMegaOnVisit(asset); 

    // 4) Incrementar contador de descargas (Prisma, sin SQL crudo)
    await prisma.asset.update({
      where: { id },
      data: { downloads: { increment: 1 } },
    });

    // 5) Registrar historial de descarga si hay usuario
    if (userId) {
      let assetTitle = null;
      try {
        const a = await prisma.asset.findUnique({
          where: { id },
          select: { title: true },
        });
        assetTitle = a?.title || null;
      } catch {
        // best-effort
      }

      await prisma.downloadHistory.create({
        data: { userId, assetId: id, assetTitle },
      });

      // Mantener sólo las 20 más recientes por usuario
      const count = await prisma.downloadHistory.count({ where: { userId } });
      if (count > 20) {
        const old = await prisma.downloadHistory.findMany({
          where: { userId },
          orderBy: { downloadedAt: 'desc' },
          skip: 20,
          select: { id: true },
        });
        if (old.length) {
          await prisma.downloadHistory.deleteMany({
            where: { id: { in: old.map((o) => o.id) } },
          });
        }
      }
    }

    // 6) Devolver el link
    // Recomendación futura: en vez de exponer megaLink, redirigir 302 a una URL efímera firmada.
    return res.json({ ok: true, link: asset.megaLink });
  } catch (e) {
    console.error('[ASSETS] requestDownload error:', e?.message || e);
    return res.status(500).json({ message: 'Error processing download' });
  }
};

// Obtener asset por slug (página detalle SEO)
export const getAssetBySlug = async (req, res) => {

    console.log('getAssetBySlug called with paramsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:', req.params);

    try {
        const slug = String(req.params.slug || '').trim();
        if (!slug) return res.status(400).json({ message: 'slug required' });
            const a = await prisma.asset.findUnique({
            where: { slug },
            include: {
                categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
                tags: { select: { slug: true, name: true, nameEn: true, slugEn: true } },
            },
        });
        if (!a) return res.status(404).json({ message: 'Asset not found' });
        // ANTES: filtrábamos por status === PUBLISHED. Ahora devolvemos siempre el asset y exponemos flag para el frontend.
            const tagsEs = Array.isArray(a.tags) ? a.tags.map(t => t.slug).filter(Boolean) : [];
            const tagsEn = Array.isArray(a.tags) ? a.tags.map(t => (t.nameEn || t.name || t.slug)).filter(Boolean) : [];

            // Sanitizar BigInt (archiveSizeB, fileSizeB, etc.) reutilizando helper toJsonSafe definido arriba.
            let safe = a;
            try { safe = toJsonSafe(a); } catch {}

            // --- AUTOGENERACIÓN DE DESCRIPCIÓN (sólo si falta) ---
            // Campos presentes: safe.title, safe.titleEn, categories[], tagsEs, tagsEn, isPremium.
            const hasDescriptionEs = typeof safe.description === 'string' && safe.description.trim().length > 0;
            const hasDescriptionEn = typeof safe.descriptionEn === 'string' && safe.descriptionEn.trim().length > 0;

            const primaryCategoryEs = Array.isArray(safe.categories) && safe.categories.length
                ? (safe.categories[0].name || safe.categories[0].slug || '').trim()
                : '';
            const primaryCategoryEn = Array.isArray(safe.categories) && safe.categories.length
                ? (safe.categories[0].nameEn || safe.categories[0].name || safe.categories[0].slugEn || safe.categories[0].slug || '').trim()
                : '';

            const normTitleEs = (safe.title || '').replace(/^\s*STL\s*-/i, '').trim();
            const normTitleEn = (safe.titleEn || safe.title || '').replace(/^\s*STL\s*-/i, '').trim();

            const tagsSnippetEs = tagsEs.slice(0, 6).join(', ');
            const tagsSnippetEn = tagsEn.slice(0, 6).join(', ');

            function buildDescriptionEs() {
                const titular = normTitleEs || safe.slug;
                const intro = safe.isPremium
                    ? `Descarga STL premium de "${titular}" vía MEGA (acceso rápido y seguro).`
                    : `Descarga gratuita STL de "${titular}" vía MEGA al instante.`;
                const cat = primaryCategoryEs ? ` Categoría: ${primaryCategoryEs}.` : '';
                const acceso = safe.isPremium
                    ? ' Suscríbete para desbloquear la descarga y más modelos exclusivos.'
                    : ' Imprime en 3D hoy mismo sin costo.';
                const tags = tagsSnippetEs ? ` Tags: ${tagsSnippetEs}.` : '';
                let full = intro + cat + acceso + tags;
                // Limitar a ~300 chars para evitar exceso en meta description
                if (full.length > 300) full = full.slice(0, 297).replace(/[,.;:!\s]+$/,'') + '...';
                return full;
            }
            function buildDescriptionEn() {
                const titular = normTitleEn || safe.slug;
                const intro = safe.isPremium
                    ? `Premium STL download of "${titular}" via MEGA (fast & secure access).`
                    : `Free STL download of "${titular}" via MEGA instantly.`;
                const cat = primaryCategoryEn ? ` Category: ${primaryCategoryEn}.` : '';
                const acceso = safe.isPremium
                    ? ' Subscribe to unlock this model and more exclusive designs.'
                    : ' Print it today at no cost.';
                const tags = tagsSnippetEn ? ` Tags: ${tagsSnippetEn}.` : '';
                let full = intro + cat + acceso + tags;
                if (full.length > 300) full = full.slice(0, 297).replace(/[,.;:!\s]+$/,'') + '...';
                return full;
            }

            const autoDescriptionEs = hasDescriptionEs ? safe.description : buildDescriptionEs();
            const autoDescriptionEn = hasDescriptionEn ? safe.descriptionEn : buildDescriptionEn();

            return res.json({
                ...safe,
                tagsEs,
                tagsEn,
                unpublished: a.status !== 'PUBLISHED',
                description: autoDescriptionEs,
                descriptionEn: autoDescriptionEn,
            });
    } catch (e) {
        console.error('[ASSETS] getAssetBySlug error:', e);
        return res.status(500).json({ message: 'Error getting asset by slug' });
    }
};

// Listar todos los slugs publicados (para sitemap / SEO)
// GET /api/assets/slugs
// Opcional: ?updatedAfter=ISOString para delta sitemaps en el futuro
export const listPublishedSlugs = async (req, res) => {
    try {
        const { updatedAfter } = req.query || {};
        const where = { status: 'PUBLISHED' };
        if (updatedAfter) {
            const d = new Date(updatedAfter);
            if (!isNaN(d.getTime())) where.updatedAt = { gt: d };
        }
        const rows = await prisma.asset.findMany({
            where,
            select: { slug: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' },
            take: 50000, // límite amplio; si se supera, paginar
        });
        return res.json(rows);
    } catch (e) {
        console.error('[ASSETS] listPublishedSlugs error:', e);
        return res.status(500).json({ message: 'Error listing slugs' });
    }
};

// Randomizar freebies: poner todos los publicados como premium y luego seleccionar N aleatorios para dejarlos gratis
export const randomizeFree = async (req, res) => {
    try {
        const bodyCount = req.body?.count;
        const queryCount = req.query?.count;
        const hasRequestCount = bodyCount !== undefined || queryCount !== undefined;
        const envCount = getRandomizeFreebiesCountFromEnv(process.env);

        const count = hasRequestCount ? (bodyCount ?? queryCount ?? 0) : envCount;

        const result = await randomizeFreebies({ count, prisma });
        return res.json({ total: result.total, selected: result.selected, count: result.count });
    } catch (e) {
        console.error('[ASSETS] randomizeFree error:', e);
        return res.status(500).json({ message: 'Error randomizing freebies' });
    }
};


// Restaura un asset desde su backup usando solo TEMP_DIR.
// Flujo: login backup -> mega-get a TEMP_DIR -> login main -> mkdir -> mega-put -> export/get link -> update DB -> limpia archivo.
export async function restoreAssetFromBackup(req, res) {
  const assetId = Number(req.params.assetId ?? req.body?.assetId);
  const preferBackupAccountId = req.body?.backupId ? Number(req.body.backupId) : null;

  if (!Number.isFinite(assetId) || assetId <= 0) {
    return res.status(400).json({ message: 'Invalid asset id' });
  }

  // --- Helper robusto para exportar/recuperar link público (mismo estilo de subida) ---
  async function getOrCreateLink(remoteFile, label = 'RESTORE EXPORT') {
    const ATTEMPTS = Number(process.env.MEGA_EXPORT_ATTEMPTS || 5);
    const BASE_TIMEOUT = Number(process.env.MEGA_EXPORT_BASE_TIMEOUT_MS || 20000);

    const tryGet = async (timeout, tag='GET') => {
      const out = await new Promise((resolve, reject) => {
        let buf = '';
        const child = spawn('mega-export', [remoteFile], { shell: true });
        attachAutoAcceptTerms(child, `${label} ${tag}`);
        const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} ; reject(new Error(`mega-export timeout ${timeout}ms`)) }, timeout);
        child.stdout.on('data', d => buf += d.toString());
        child.stderr.on('data', d => buf += d.toString());
        child.on('close', code => { clearTimeout(to); return code === 0 ? resolve(buf) : reject(new Error(`mega-export exited ${code}`)); });
      });
      const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i);
      return m ? m[0] : null;
    };

    const tryCreate = async (timeout, tag='CREATE') => {
      const out = await new Promise((resolve, reject) => {
        let buf = '';
        const child = spawn('mega-export', ['-a', remoteFile], { shell: true });
        attachAutoAcceptTerms(child, `${label} ${tag}`);
        const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} ; reject(new Error(`mega-export -a timeout ${timeout}ms`)) }, timeout);
        child.stdout.on('data', d => buf += d.toString());
        child.stderr.on('data', d => buf += d.toString());
        child.on('close', code => { clearTimeout(to); return code === 0 ? resolve(buf) : reject(Object.assign(new Error(`mega-export -a exited ${code}`), { code })); });
      });
      const m = String(out).match(/https?:\/\/mega\.nz\/\S+/i);
      return m ? m[0] : null;
    };

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const timeout = Math.round(BASE_TIMEOUT * (1 + (attempt - 1) * 0.6));

      // 1) intentar obtener link existente
      try {
        const got = await tryGet(timeout, `try=${attempt} GET`);
        if (got) return got;
      } catch (e) {
        // silencioso; seguimos a crear
      }

      // 2) intentar crear
      try {
        const created = await tryCreate(timeout, `try=${attempt} CREATE`);
        if (created) return created;
      } catch (e) {
        // Si está "already exported" (exit 64), volvemos a GET y devolvemos
        if (String(e.message || '').includes('exited 64')) {
          try {
            const got = await tryGet(timeout, `try=${attempt} GET-ON-64`);
            if (got) return got;
          } catch {}
        }
        // log leve
        console.warn(`[${label}] intento=${attempt} warn: ${e.message}`);
      }

      if (attempt < ATTEMPTS) {
        const backoff = 1000 + attempt * 1500;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    console.warn(`[${label}] sin link tras reintentos`);
    return null;
  }

  try {
    // 1) Cargar asset + cuentas
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: {
        account: { include: { credentials: true } }, // main
        replicas: {
          where: { status: 'COMPLETED' },
          include: { account: { include: { credentials: true } } }, // backups
        },
      },
    });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    if (!asset.account?.credentials) {
      return res.status(400).json({ message: 'Main account has no credentials' });
    }

    const candidates = (asset.replicas || []).filter(r => r.account?.credentials);
    if (!candidates.length) {
      return res.status(409).json({ message: 'No completed backup replicas found' });
    }

    const chosen = preferBackupAccountId
      ? (candidates.find(r => r.accountId === preferBackupAccountId) || candidates[0])
      : candidates[0];

    const mainAcc = asset.account;
    const backupAcc = chosen.account;

    // 2) Nombre de archivo
    const fileName = asset.archiveName ? path.basename(asset.archiveName) : null;
    if (!fileName) {
      return res.status(409).json({ message: 'Asset has no archiveName to restore' });
    }

    // 3) Paths remotos (reproducir EXACTA estructura del backup en el main)
    const backupBase = (backupAcc.baseFolder || '/').replaceAll('\\', '/');
    const replicaFolderRaw = (chosen.remotePath ? chosen.remotePath.replaceAll('\\', '/') : null)
      || path.posix.join(backupBase, asset.slug);
    // relPath: qué hay por debajo del base del backup
    let relFromBackupBase = path.posix.relative(backupBase, replicaFolderRaw);
    if (!relFromBackupBase || relFromBackupBase.startsWith('..')) {
      // si no cuelga del base, fallback al slug
      relFromBackupBase = asset.slug;
    }

    const backupRemoteFile = path.posix.join(replicaFolderRaw, fileName);

    const mainBase = (mainAcc.baseFolder || '/').replaceAll('\\', '/');
    const mainRemoteFolder = path.posix.join(mainBase, relFromBackupBase);
    const mainRemoteFile = path.posix.join(mainRemoteFolder, fileName);

    // 4) Área temporal: SOLO TEMP_DIR
    ensureDir(TEMP_DIR);
    const localPath = path.join(TEMP_DIR, fileName);
    try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch {}

    // 5) LOGIN backup -> mega-get
    const backupCred = decryptToJson(
      backupAcc.credentials.encData,
      backupAcc.credentials.encIv,
      backupAcc.credentials.encTag
    );

    await withMegaLock(async () => {
      try { await runCmd('mega-logout', []); } catch {}
      if (backupCred?.type === 'session' && backupCred.session) {
        await runCmd('mega-login', [backupCred.session]);
      } else if (backupCred?.username && backupCred?.password) {
        await runCmd('mega-login', [backupCred.username, backupCred.password]);
      } else {
        throw new Error('Invalid backup credentials payload');
      }

      console.log(`[RESTORE] Download from backup acc=${backupAcc.id} path=${backupRemoteFile}`);
      await runCmd('mega-get', [backupRemoteFile, '.'], { cwd: TEMP_DIR });

      // Asegurar existencia local
      if (!fs.existsSync(localPath)) {
        const entries = fs.readdirSync(TEMP_DIR).filter(n => {
          const p = path.join(TEMP_DIR, n);
          return fs.existsSync(p) && fs.statSync(p).isFile();
        });
        const found = entries.find(n => n.toLowerCase() === fileName.toLowerCase()) || null;
        if (found && found !== fileName) {
          fs.renameSync(path.join(TEMP_DIR, found), localPath);
        }
      }
      if (!fs.existsSync(localPath)) {
        throw new Error('Downloaded file not found locally after mega-get');
      }

      try { await runCmd('mega-logout', []); } catch {}
    }, `RESTORE-BACKUP-${backupAcc.id}`);

    // 6) LOGIN main -> mkdir -p -> (opcional) evitar re-subida si ya existe -> export/get link
    const mainCred = decryptToJson(
      mainAcc.credentials.encData,
      mainAcc.credentials.encIv,
      mainAcc.credentials.encTag
    );

    let publicLink = null;

    await withMegaLock(async () => {
      try { await runCmd('mega-logout', []); } catch {}
      if (mainCred?.type === 'session' && mainCred.session) {
        await runCmd('mega-login', [mainCred.session]);
      } else if (mainCred?.username && mainCred?.password) {
        await runCmd('mega-login', [mainCred.username, mainCred.password]);
      } else {
        throw new Error('Invalid main credentials payload');
      }

      await safeMkdir(mainRemoteFolder);

      // Si ya existe en MAIN, saltamos la subida (solo generamos/reusamos link)
      let existsMain = false;
      try { await runCmd('mega-ls', [mainRemoteFile]); existsMain = true; } catch {}

      if (!existsMain) {
        console.log(`[RESTORE] Upload to main acc=${mainAcc.id} dest=${mainRemoteFolder}`);
        await runCmd('mega-put', [localPath, mainRemoteFolder]);
      } else {
        console.log('[RESTORE] Archivo ya existe en main. No se re-sube.');
      }

      // Recuperar/crear link (maneja "already exported")
      publicLink = await getOrCreateLink(mainRemoteFile, 'RESTORE EXPORT');
      if (publicLink) console.log(`[RESTORE] Link: ${publicLink}`);
      else console.warn('[RESTORE] No se pudo obtener link público');

            // Mantener métricas de la cuenta main sincronizadas en la misma sesión
            // donde se restaura/sube el archivo.
            try {
                await refreshAccountStorageFromMegaDfInCurrentSession(
                    mainAcc.id,
                    `restore asset=${asset.id} mainAccId=${mainAcc.id}`
                );
            } catch {}

      try { await runCmd('mega-logout', []); } catch {}
    }, `RESTORE-MAIN-${mainAcc.id}`);

    // 7) Actualizar DB
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        status: 'PUBLISHED',
        megaLink: publicLink || undefined,
        megaLinkAlive: publicLink ? true : null,
        megaLinkCheckedAt: publicLink ? new Date() : null,
      },
    });

    // 8) Limpieza TEMP
    try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch {}

    // 9) Notificación
    try {
      await prisma.notification.create({
        data: {
          title: 'Asset restaurado desde backup',
          body: `El asset "${asset.title}" (id: ${asset.id}) fue restaurado desde backup accId=${backupAcc.id} hacia la cuenta principal accId=${mainAcc.id}.`,
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'SUCCESS',
        },
      });
    } catch {}

    return res.json({ ok: true, link: publicLink });
  } catch (err) {
    console.error('[RESTORE] error:', err?.message || err);

    // limpieza best-effort del TEMP
    try {
      const fileName = String(req?.body?.fileName || '');
      if (fileName) {
        const p = path.join(TEMP_DIR, path.basename(fileName));
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}

    try {
      await prisma.notification.create({
        data: {
          title: 'Error al restaurar asset desde backup',
          body: `Asset id=${assetId}. Detalle: ${err?.message || err}`,
          status: 'UNREAD',
          type: 'AUTOMATION',
          typeStatus: 'ERROR',
        },
      });
    } catch {}

    return res.status(500).json({ message: 'Restore failed', error: String(err.message || err) });
  }
}

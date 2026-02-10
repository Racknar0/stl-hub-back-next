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
function safeName(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
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
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
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

function tokenizeSimilarQuery(input) {
    const base = stripExtension(String(input || '').trim());
    const baseNoDigits = String(base).replace(/\d+/g, ' ').trim();
    const baseNorm = normalizeForCompare(base);
    const baseNoDigitsNorm = normalizeForCompare(baseNoDigits);

    const rawParts = String(base)
        .split(/[^a-zA-Z0-9]+/g)
        .map((t) => String(t || '').trim())
        .filter(Boolean);

    const tokens = [];
    for (const p of rawParts) {
        const low = String(p).toLowerCase().trim();
        if (low.length >= 3) tokens.push(low);

        const noDigits = stripDigitsKeepLetters(low);
        if (noDigits && noDigits.length >= 3) tokens.push(noDigits);

        // Prefijo para casos como pikachu1 -> pika (y evitar excluir por sufijos/números)
        const prefixSource = noDigits && noDigits.length >= 4 ? noDigits : low;
        if (prefixSource && prefixSource.length >= 4) tokens.push(prefixSource.slice(0, 4));
    }

    const strongTokens = uniqueStrings(tokens)
        .map((t) => String(t).trim())
        .filter((t) => t.length >= 3)
        .slice(0, 12);

    const searchTerms = uniqueStrings([base, baseNoDigits, ...strongTokens])
        .map((t) => String(t || '').trim())
        .filter((t) => t.length >= 3)
        .slice(0, 14);

    return { base, baseNorm, baseNoDigits, baseNoDigitsNorm, strongTokens, searchTerms };
}

function tokenizeCandidateForScore(s) {
    const parts = String(s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((t) => stripDigitsKeepLetters(t))
        .filter((t) => t && t.length >= 3);
    return new Set(parts.map((t) => normalizeForCompare(t)).filter(Boolean));
}

// Listar y obtener
export const listAssets = async (req, res) => {
    try {
    const { q = '', pageIndex, pageSize, plan, isPremium, accountId, accountAlias } = req.query;
        const hasPagination = pageIndex !== undefined && pageSize !== undefined;

        // Construir filtro dinámico
        const where = {};
        if (q) {
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

// Buscar assets similares (para uploader): por nombre de archivo/slug aproximado
// GET /assets/similar?filename=naruto.rar&limit=8&sizeB=123456
export const similarAssets = async (req, res) => {
    try {
        const raw = String(req.query?.filename || req.query?.q || '').trim();
        if (!raw) return res.status(400).json({ message: 'filename required' });

        const limit = Math.max(1, Math.min(25, Number(req.query?.limit) || 8));
        const querySizeB = Number(req.query?.sizeB || req.query?.sizeBytes || 0);
        const hasQuerySize = Number.isFinite(querySizeB) && querySizeB > 0;

        const { base, baseNorm, baseNoDigits, baseNoDigitsNorm, strongTokens, searchTerms } = tokenizeSimilarQuery(raw);

        const extractLastSegment = (s) => {
            const t = String(s || '');
            const parts = t.split(/[\\/]+/g).filter(Boolean);
            return parts.length ? parts[parts.length - 1] : t;
        };

        const stripExt = (s) => {
            const t = String(s || '');
            return t.replace(/\.[a-z0-9]{1,6}$/i, '');
        };

        const getCandidateKey = (it) => {
            const last = extractLastSegment(it?.archiveName || it?.slug || it?.title || '');
            return normalizeForCompare(stripExt(last));
        };

        const where = {};
        if (searchTerms.length) {
            where.OR = searchTerms.flatMap((term) => [
                { archiveName: { contains: term } },
                { title: { contains: term } },
                { slug: { contains: safeName(term) } },
            ]);
        }

        const items = await prisma.asset.findMany({
            where,
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
            },
            // subir el pool para evitar perder coincidencias válidas si hay muchos matches (p.ej. "pikachu")
            take: 900,
            orderBy: { id: 'desc' },
        });

        const queryTokenSet = new Set(
            (strongTokens || [])
                .map((t) => normalizeForCompare(stripDigitsKeepLetters(t)))
                .filter((t) => t && t.length >= 3)
        );

        const scored = (items || [])
            .map((it) => {
                const candidateText = `${it.archiveName || ''} ${it.title || ''} ${it.titleEn || ''} ${it.slug || ''}`;
                const nameNorm = normalizeForCompare(candidateText);
                const keyNorm = getCandidateKey(it);
                let score = 0;

                // 1) Prioridad máxima: match exacto de nombre (base) contra el archivo/slug (sin extensión)
                if (baseNorm && keyNorm && keyNorm === baseNorm) score += 260;
                if (baseNoDigitsNorm && keyNorm && keyNorm === baseNoDigitsNorm) score += 240;

                if (baseNoDigitsNorm && nameNorm === baseNoDigitsNorm) score += 120;
                if (baseNorm && nameNorm === baseNorm) score += 110;
                if (baseNoDigitsNorm && nameNorm.includes(baseNoDigitsNorm)) score += 70;
                if (baseNorm && nameNorm.includes(baseNorm)) score += 45;

                for (const t of strongTokens || []) {
                    const tNorm = normalizeForCompare(stripDigitsKeepLetters(t));
                    if (tNorm && nameNorm.includes(tNorm)) score += 14;
                }

                // Bonus por overlap de tokens (evita que un único sufijo/número deje fuera coincidencias claras)
                if (queryTokenSet.size) {
                    const candTokenSet = tokenizeCandidateForScore(candidateText);
                    let hits = 0;
                    for (const qt of queryTokenSet) {
                        if (candTokenSet.has(qt)) hits += 1;
                    }
                    const ratio = hits / queryTokenSet.size;
                    score += Math.round(30 * ratio);
                }

                const imgCount = Array.isArray(it.images) ? it.images.length : 0;
                score += Math.min(20, imgCount * 2);
                if (it.archiveName) score += 5;

                // 2) Peso similar (solo suma si ya hay similitud de nombre, para evitar falsos positivos por tamaño)
                if (hasQuerySize && score >= 20) {
                    const candSize = Number(it?.fileSizeB ?? it?.archiveSizeB ?? 0);
                    if (Number.isFinite(candSize) && candSize > 0) {
                        const denom = Math.max(querySizeB, candSize);
                        const diffRatio = denom ? Math.abs(candSize - querySizeB) / denom : 1;
                        // Bonus escalonado (más fuerte cuanto más cercano)
                        if (diffRatio <= 0.01) score += 70;
                        else if (diffRatio <= 0.03) score += 55;
                        else if (diffRatio <= 0.07) score += 38;
                        else if (diffRatio <= 0.15) score += 20;
                        else if (diffRatio <= 0.25) score += 10;
                    }
                }

                return { ...it, _score: score };
            })
            .sort((a, b) => {
                if (b._score !== a._score) return b._score - a._score;
                return Number(new Date(b.updatedAt)) - Number(new Date(a.updatedAt));
            })
            .slice(0, limit);

        const safe = toJsonSafe(scored).map(({ _score, ...rest }) => rest);
        return res.json({ query: raw, base, tokens: strongTokens, items: safe });
    } catch (e) {
        console.error('[ASSETS] similarAssets error:', e);
        return res.status(500).json({ message: 'Error searching similar assets' });
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

        const { title, titleEn, categories, tags, isPremium } = req.body;
        const data = {};
        if (title !== undefined) data.title = String(title);
        if (titleEn !== undefined) data.titleEn = String(titleEn);
        if (typeof isPremium !== 'undefined')
            data.isPremium = Boolean(isPremium);

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
        const updatedSafe = toJsonSafe(updated);
        return res.json(updatedSafe);
    } catch (e) {
        console.error('[ASSETS] update error:', e);
        return res.status(500).json({ message: 'Error updating asset' });
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

        enqueueToMegaBatch(created.id).catch((err) =>
            console.error('[MEGA-UP][BATCH] async error:', err)
        );

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
            cleanupPaths.forEach((p) => {
                if (p && fs.existsSync(p)) fs.unlinkSync(p);
            });
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

// GET /api/assets/scp-config (admin-only)
// Devuelve configuración de SCP desde el servidor (no incluye password)
export const getScpConfig = async (_req, res) => {
    try {
        const host = process.env.SCP_HOST || '';
        const user = process.env.SCP_USER || '';
        const port = Number(process.env.SCP_PORT || 22);
        const remoteBase = process.env.SCP_REMOTE_BASE || '';
        return res.json({ host, user, port, remoteBase });
    } catch (e) {
        return res.status(500).json({ message: 'Error getting SCP config' });
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
        child.stdout.on('data', (d) =>
            console.log(`[MEGA] ${d.toString().trim()}`)
        );
        child.stderr.on('data', (d) =>
            console.error(`[MEGA] ${d.toString().trim()}`)
        );
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
    const m = s.match(/[\d.,]+\s*[KMGT]?B/);
    if (!m) return 0;
    const num = parseFloat((m[0].match(/[\d.,]+/) || ['0'])[0].replace(',', '.'));
    const unit = (m[0].match(/[KMGT]?B/) || ['MB'])[0];
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

async function uploadOneAssetMainInCurrentSession(assetId, mainAcc) {
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
                lastLoggedMain = p;
                console.log(`[PROGRESO] asset=${asset.id} main ${p}%`);
            }
        }
        if (/upload finished/i.test(txt)) {
            progressMap.set(asset.id, 100);
            if (lastLoggedMain !== 100) console.log(`[PROGRESO] asset=${asset.id} main 100%`);
        }
    };

    const putCmd = 'mega-put';
    const exportCmd = 'mega-export';

    await safeMkdir(remotePath);
    await new Promise((resolve, reject) => {
        const child = spawn(putCmd, [localArchive, remotePath], { shell: true });
        attachAutoAcceptTerms(child, 'MEGA PUT');
        child.stdout.on('data', (d) => parseProgress(d));
        child.stderr.on('data', (d) => parseProgress(d));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${putCmd} exited ${code}`))));
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

async function replicateOneAssetToBackupInCurrentSession(assetId, backupAcc) {
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

    const putCmd = 'mega-put';
    const exportCmd = 'mega-export';
    let publicLink = null;

    await safeMkdir(remotePath);
    const fileName = path.basename(archiveAbs);
    await new Promise((resolve, reject) => {
        const child = spawn(putCmd, [archiveAbs, remotePath], { shell: true });
        attachAutoAcceptTerms(child, `REPLICA PUT acc=${backupAcc.id}`);
        let lastLogged = -1;
        const parseProgress = (buf) => {
            const txt = buf.toString();
            let last = null;
            const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g;
            let m;
            while ((m = re.exec(txt)) !== null) last = m[1];
            if (last !== null) {
                const p = Math.max(0, Math.min(100, parseFloat(last)));
                const key = `${asset.id}:${backupAcc.id}`;
                const prev = replicaProgressMap.get(key) || 0;
                if (p === 100 || p >= prev + 1) replicaProgressMap.set(key, p);
                if (p === 100 || p >= lastLogged + 5) {
                    lastLogged = p;
                    console.log(`[PROGRESO] asset=${asset.id} backup=${backupAcc.id} ${p}%`);
                }
            }
        };
        child.stdout.on('data', (d) => parseProgress(d));
        child.stderr.on('data', (d) => parseProgress(d));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${putCmd} exited ${code}`))));
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
                            if (st.cutToBackupsRequested) {
                                // Corte solicitado: no iniciar más MAIN en este batch.
                                break;
                            }

                            st.currentAssetId = aid;
                            try {
                                // Si MEGAcmd pierde la sesión (proxy inestable / timeout / error previo),
                                // los siguientes comandos fallan con "Not logged in" (exit 57). Reintentamos 1 vez con re-login.
                                let okId = null;
                                try {
                                    okId = await uploadOneAssetMainInCurrentSession(aid, mainAcc);
                                } catch (e) {
                                    if (isNotLoggedInError(e)) {
                                        console.warn(`[BATCH][MAIN] session lost before/while asset=${aid} -> relogin & retry`);
                                        await megaLoginWithProxyRotationOrThrow('MAIN', mainPayload, proxies, ctxMain, { maxTries: 3 });
                                        okId = await uploadOneAssetMainInCurrentSession(aid, mainAcc);
                                    } else {
                                        throw e;
                                    }
                                }
                                uploadedAssetIds.push(okId);
                            } catch (e) {
                                console.error(`[BATCH][MAIN] fail asset=${aid} msg=${e.message}`);
                                progressMap.delete(aid);
                                try { await prisma.asset.update({ where: { id: aid }, data: { status: 'FAILED' } }); } catch {}

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
                            await replicateOneAssetToBackupInCurrentSession(aid, b);
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
                        }
                        st.backupIndex = (Number(st.backupIndex) || 0) + 1;
                        st.currentReplicaAssetId = null;
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
                await new Promise((resolve, reject) => {
                    const child = spawn(putCmd, [archiveAbs, remotePath], {
                        shell: true,
                    });
                    attachAutoAcceptTerms(child, `REPLICA PUT acc=${b.id}`);
                    let lastLogged = -1;
                    const parseProgress = (buf) => {
                        const txt = buf.toString();
                        let last = null;
                        const re = /([0-9]{1,3}(?:\.[0-9]+)?)\s*%/g;
                        let m;
                        while ((m = re.exec(txt)) !== null) last = m[1];
                        if (last !== null) {
                            const p = Math.max(
                                0,
                                Math.min(100, parseFloat(last))
                            );
                            if (p !== lastLogged) {
                                lastLogged = p;
                                if (p === 100 || p >= lastLogged + 5) {
                                    lastLogged = p;
                                    console.log(
                                        `[PROGRESO] asset=${asset.id} backup=${b.id} ${p}%`
                                    );
                                }
                                replicaProgressMap.set(
                                    `${asset.id}:${b.id}`,
                                    p
                                );
                            }
                        }
                    };
                    child.stdout.on('data', (d) => parseProgress(d));
                    child.stderr.on('data', (d) => parseProgress(d));
                    child.on('close', (code) =>
                        code === 0
                            ? resolve()
                            : reject(new Error(`${putCmd} exited ${code}`))
                    );
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

        const loginCmd = 'mega-login';
        const rmCmd = 'mega-rm';
        const logoutCmd = 'mega-logout';

        const results = [];
        for (const entry of accountsToDelete) {
            const { acc } = entry;
            let deleted = false;
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
                    try {
                        await runCmd(logoutCmd, []);
                    } catch {}
                    if (payload?.type === 'session' && payload.session)
                        await runCmd(loginCmd, [payload.session]);
                    else if (payload?.username && payload?.password)
                        await runCmd(loginCmd, [
                            payload.username,
                            payload.password,
                        ]);
                    else throw new Error('Invalid credentials payload');
                    try {
                        await runCmd(rmCmd, ['-rf', remotePath]);
                        deleted = true;
                    } catch (e) {
                        console.warn(
                            `[ASSETS] rm warn acc=${acc.id}:`,
                            e.message
                        );
                    }
                    try {
                        await runCmd(logoutCmd, []);
                    } catch {}
                }, `DEL-${acc.id}`);
            } catch (e) {
                console.warn(
                    '[ASSETS] mega delete warn acc=' + acc.id,
                    e.message
                );
            }
            results.push({ accountId: acc.id, kind: entry.kind, deleted });
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

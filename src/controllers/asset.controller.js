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

const prisma = new PrismaClient();

// Progreso en memoria por assetId (0..100)
const progressMap = new Map();
// Progreso de réplicas: key `${assetId}:${accountId}` -> 0..100
const replicaProgressMap = new Map();

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

// Listar y obtener
export const listAssets = async (req, res) => {
    try {
        const { q = '', pageIndex, pageSize, plan, isPremium } = req.query;
        const hasPagination = pageIndex !== undefined && pageSize !== undefined;

        // Construir filtro dinámico
        const where = {};
        if (q) {
            where.title = { contains: String(q) };
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
            enqueueToMegaReal(asset)
                .catch(async (err) => {
                    console.error('[ASSETS] enqueueToMegaReal error:', err);
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

        enqueueToMegaReal(created).catch((err) =>
            console.error('[MEGA-UP] async error:', err)
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
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { shell: true, ...options });
        child.stdout.on('data', (d) =>
            console.log(`[MEGA] ${d.toString().trim()}`)
        );
        child.stderr.on('data', (d) =>
            console.error(`[MEGA] ${d.toString().trim()}`)
        );
        child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
        );
    });
}

// mega-mkdir retorna código 54 cuando la carpeta ya existe; lo tratamos como éxito silencioso.
async function safeMkdir(remotePath) {
    const mkdirCmd = 'mega-mkdir';
    return new Promise((resolve, reject) => {
        const child = spawn(mkdirCmd, ['-p', remotePath], { shell: true });
        let stderrBuf = '';
        child.stdout.on('data', (d) =>
            console.log(`[MEGA] ${d.toString().trim()}`)
        );
        child.stderr.on('data', (d) => {
            const s = d.toString();
            stderrBuf += s;
            console.error(`[MEGA] ${s.trim()}`);
        });
        child.on('close', (code) => {
            if (code === 0) return resolve();
            if (code === 54 || /Folder already exists/i.test(stderrBuf)) {
                console.log(`[MEGA] mkdir exists (code=${code}) -> ok`);
                return resolve();
            }
            return reject(new Error(`${mkdirCmd} exited ${code}`));
        });
    });
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
        return res.json({
            main: { status: asset.status, progress: mainProgress },
            replicas: replicaItems,
            totalTargets,
            overallPercent,
            allDone,
            expectedReplicas,
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
        let n = Number(req.body?.count ?? req.query?.count ?? 0);
        if (!Number.isFinite(n) || n < 0) n = 0;

        const where = { status: 'PUBLISHED' };

        // Total de assets publicados
        const total = await prisma.asset.count({ where });
        if (total === 0) return res.json({ total: 0, selected: 0 });

        // Paso 1: marcar todos como premium
        await prisma.asset.updateMany({ where, data: { isPremium: true } });

        // Paso 2: seleccionar N aleatorios para dejar free
        if (n > 0) {
            const rows = await prisma.asset.findMany({
                where,
                select: { id: true },
            });
            const ids = rows.map((r) => r.id);
            // Fisher-Yates shuffle parcial
            for (let i = ids.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const tmp = ids[i];
                ids[i] = ids[j];
                ids[j] = tmp;
            }
            const pick = ids.slice(0, Math.min(n, ids.length));
            await prisma.asset.updateMany({
                where: { id: { in: pick } },
                data: { isPremium: false },
            });
            return res.json({ total, selected: pick.length });
        }

        return res.json({ total, selected: 0 });
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

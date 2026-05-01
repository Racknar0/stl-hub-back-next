import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { decryptToJson } from '../utils/cryptoUtils.js';
import jwt from 'jsonwebtoken';
import { withMegaLock } from '../utils/megaQueue.js';
import { checkMegaLinkAlive } from '../utils/megaCheckFiles/megaLinkChecker.js';
import { maybeCheckMegaOnVisit } from '../utils/megaCheckFiles/visitTriggeredMegaCheck.js';
import { applyMegaProxy, listMegaProxies } from '../utils/megaProxy.js';
import { createPartFromBase64, GoogleGenAI, PartMediaResolutionLevel } from '@google/genai';
import qdrantMultimodalService from '../services/qdrantMultimodal.service.js';

const prisma = new PrismaClient();
import { randomizeFreebies, getRandomizeFreebiesCountFromEnv } from '../utils/randomizeFreebies.js';


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

const UPLOADS_DIR = path.resolve('uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const BATCH_IMPORTS_DIR = path.join(UPLOADS_DIR, 'batch_imports');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const ARCHIVES_DIR = path.join(UPLOADS_DIR, 'archives');
const SYNC_CACHE_DIR = path.join(UPLOADS_DIR, 'sync-cache');

/** Eliminar todo el contenido de un directorio recursivamente. */
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


/** Crear directorio si no existe, incluyendo padres. */
function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}


/** Normalizar string a formato URL-safe (minúsculas, solo alfanuméricos, guiones). */
function safeName(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

/** Normalizar par de IDs de assets (ordenar menor primero) para evitar duplicados. */
function normalizePairForStore(assetAId, assetBId) {
    const a = Number(assetAId);
    const b = Number(assetBId);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0)
        return null;
    if (a === b) return null;
    return a < b ? { assetAId: a, assetBId: b } : { assetAId: b, assetBId: a };
}

/** Convertir valor a array de strings no vacíos. */
function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((v) => String(v || '').trim()).filter(Boolean);
}

/** Resolver ruta relativa a absoluta dentro de uploads/, con validación de path traversal. */
function getSafeUploadAbsolutePath(relPath) {
    const rel = String(relPath || '').replace(/^[/\\]+/, '');
    if (!rel) return null;
    const abs = path.resolve(path.join(UPLOADS_DIR, rel));
function isPrismaMissingTableError(err) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '').toLowerCase();
    return (
        code === 'P2021' ||
        msg.includes('does not exist') ||
        msg.includes('unknown table')
    );
}

/** Sincronizar hashes perceptuales de imágenes de un asset en la DB. */
/** Ejecutar backfill masivo: recalcular hashes para todos los assets. */
}


/** Sanitizar nombre de archivo para almacenamiento seguro. */
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
/** Limpiar archivos temporales antiguos en uploads/tmp (por antigüedad). */
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

/** Limpiar uploads/tmp recursivamente por antigüedad, respetando carpetas de staging activas (batch_*). */
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
/** Eliminar directorios vacíos hacia arriba hasta llegar al directorio tope. */
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

/** Leer variable de entorno como booleano (soporta 1/true/yes/on). */
function envFlag(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw == null) return !!defaultValue;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    return !!defaultValue;
}


// helpers para parsear categorías múltiples (por id o slug)
/** Parsear payload de categorías: acepta IDs numéricos o slugs como array o CSV. */
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
/** Parsear payload de tags: acepta IDs numéricos o slugs como array o CSV. */
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

/** Normalizar texto de metadata SEO, truncando al largo máximo. */
function normalizeMetaText(value, maxLen = 380) {
    const txt = String(value || '').replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    if (txt.length <= maxLen) return txt;
    return `${txt.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
}

/** Normalizar texto de descripción (colapsar espacios). */
function normalizeDescriptionText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

/** Extraer ruta relativa a uploads/ desde una URL absoluta o ruta con prefijo. */
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

/** Recolectar rutas relativas de imágenes de un asset (limitado a MAX_IMAGES_PER_ITEM). */
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

/** Obtener MIME type de una imagen por su extensión. */
function getImageMimeType(filePath) {
    return IMAGE_MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] || null;
}

/** Construir partes de imagen codificadas en base64 para enviar a Gemini AI. */
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

/** Actualizar descripción de un asset y sincronizar vector en Qdrant. */
async function updateAssetDescriptionSafely(assetId, rawDescription) {
    const numericAssetId = Number(assetId);
    const safe = normalizeDescriptionText(rawDescription) || ASSET_DESCRIPTION_FALLBACK;
    await prisma.asset.update({
        where: { id: numericAssetId },
        data: { description: safe },
    });
    qdrantMultimodalService
        .upsertAssetMultimodalVector(numericAssetId)
        .catch((err) => console.error('[QDRANT] Description update error:', err));
    return safe;
}

/** Actualizar descripciones bilingües (ES/EN) de un asset y sincronizar con Qdrant. */
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
    qdrantMultimodalService
        .upsertAssetMultimodalVector(numericAssetId)
        .catch((err) => console.error('[QDRANT] Description regenerate error:', err));
    return { description: safeEs, descriptionEn: safeEn };
}

/** Parsear JSON flexible: extrae primer bloque JSON o code fence de un texto. */
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

/** Construir objeto de input normalizado para generación de metadata AI. */
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

/** Obtener instancia del cliente Gemini AI (singleton). */
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

/** Generar descripción SEO bilingüe para un asset usando Gemini AI. */
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

/** Normalizar tags generados bilingües: deduplicar y limpiar pares es/en. */
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

/** Generar pares de tags SEO (es/en) para un asset usando Gemini AI. */
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

/** Crear tags en DB si no existen y retornar sus IDs. */
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
/** Generar slug único verificando que no exista en DB. */
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
/** Serializar a JSON de forma segura (retorna null si falla). */
function toJsonSafe(value) {
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((v) => toJsonSafe(v));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
        return out;
    }
    return value;
}

// Listar y obtener
/** Listar assets con paginación, filtros y ordenamiento. GET /api/assets */
export const listAssets = async (req, res) => {
    try {
    const { q = '', pageIndex, pageSize, plan, isPremium, accountId, accountAlias, is_ai_search, categorySlug, tagSlug } = req.query;
        const hasPagination = pageIndex !== undefined && pageSize !== undefined;

        // Construir filtro dinámico
        const where = {};
        if (is_ai_search === 'true' && q) {
            const limit = pageSize ? Number(pageSize) : 50;
            const aiResults = await qdrantMultimodalService.searchByImage(null, null, String(q), limit);
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

        // Filtro por categoría (slug)
        if (categorySlug && String(categorySlug).trim()) {
            where.categories = { some: { slug: String(categorySlug).trim() } };
        }

        // Filtro por tag (slug)
        if (tagSlug && String(tagSlug).trim()) {
            where.tags = { some: { slug: String(tagSlug).trim() } };
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

// Buscar assets similares (para uploader): señal combinada por nombre + imagen + metadatos
// GET/POST /assets/similar?filename=naruto.rar&limit=8&sizeB=123456
/** Buscar assets similares por nombre, slug o hash visual. GET|POST /api/assets/similar */
// GET /assets/similar/ignored-pairs
/** Listar pares de assets ignorados en detección de duplicados. */
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
/** Agregar o actualizar pares de assets ignorados. */
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
/** Eliminar todos los pares ignorados. */
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
/** Eliminar un par ignorado específico por assetAId y assetBId. */
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

/** Verificar unicidad de slug/carpeta antes de crear un asset. GET /api/assets/check-unique */
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
/** Obtener un asset por ID con sus relaciones (account, categories, tags, replicas). GET /api/assets/:id */
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

/** Actualizar campos de un asset existente (metadata, categorías, tags, estado). PUT /api/assets/:id */
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
        
        qdrantMultimodalService.upsertAssetMultimodalVector(id).catch(err => console.error('[QDRANT] Update error:', err));
        
        const updatedSafe = toJsonSafe(updated);
        return res.json(updatedSafe);
    } catch (e) {
        console.error('[ASSETS] update error:', e);
        return res.status(500).json({ message: 'Error updating asset' });
    }
};

// POST /assets/meta/save-selected
/** Guardar metadata AI seleccionada (descripción, tags) para uno o más assets. POST /api/assets/meta/save-selected */
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

                    // Sincronizar Qdrant al guardar desde la vista Meta SEO
                    qdrantMultimodalService
                        .upsertAssetMultimodalVector(item.id)
                        .catch((err) => console.error('[QDRANT] Meta save sync error:', err));

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
/** Generar descripciones SEO con Gemini AI para assets seleccionados. POST /api/assets/meta/generate-descriptions */
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
/** Generar tags SEO bilingües con Gemini AI para assets seleccionados. POST /api/assets/meta/generate-tags */
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
            qdrantMultimodalService
                .upsertAssetMultimodalVector(asset.id)
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

/** Subir/reemplazar imágenes de un asset existente. POST /api/assets/:assetId/images */
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
                    .resize({ width: 1600, withoutEnlargement: true })
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

/** Estado de múltiples archivos en staging (uploads/tmp). Usado por batch upload para monitoreo SCP. */
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

// Igual que staged-status/batch, pero restringido a uploads/batch_imports.
/** Estado de archivos en staging para batch imports (uploads/batch_imports). */
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
/** Obtener configuración SCP del servidor (host, puerto, usuario, rutas). GET /api/assets/scp-config */
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

/** Generar comandos SCP/rsync/WinSCP para subida de archivos pesados. POST /api/assets/scp-command */
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


/** Ejecutar comando de sistema con timeout y captura de stdout/stderr. */
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
/** Crear directorio remoto en MEGA via mega-mkdir (ignora si ya existe). */
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

/** Intentar matar árbol de procesos (taskkill en Windows, SIGKILL en Linux). */
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

/** Ejecutar comando de sistema con timeout y captura de stdout/stderr. */
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

/** Refrescar datos de almacenamiento de una cuenta MEGA leyendo mega-df en sesión activa. */
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

/** Aplicar proxy MEGA via mega-proxy o fallar con error. */
async function applyProxyOrThrow(role, picked, ctx) {
    if (!picked) throw new Error(`[BATCH] Sin proxy para ${role}`);
    const r = await applyMegaProxy(picked, { ctx, timeoutMs: 15000, clearOnFail: false });
    if (!r?.enabled) throw new Error(`[BATCH] No pude aplicar proxy (${role})`);
    return r;
}

/** Intentar proxies MEGA en secuencia hasta encontrar uno funcional. */
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

/** Cerrar sesión MEGA de forma segura (ignorar errores). */
async function megaLogoutBestEffort(ctx) {
    try {
        await runCmd('mega-logout', []);
        console.log(`[MEGA][LOGOUT][OK] ${ctx}`);
    } catch {
        console.log(`[MEGA][LOGOUT][WARN] ${ctx}`);
    }
}

/** Iniciar sesión MEGA con credenciales (session string o user/pass). */
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
/** Listar réplicas de un asset con estado y progreso. GET /api/assets/:id/replicas */
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

/** Eliminar un asset: borra archivos locales, réplicas en MEGA via mega-rm, y registro en DB. DELETE /api/assets/:id */
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

        qdrantMultimodalService.deleteAssetMultimodalVector(id).catch(err => console.error('[QDRANT] Delete error:', err));

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
/** Obtener los assets más recientes publicados. GET /api/assets/latest */
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
/** Obtener los assets más descargados, agrupados por categoría con colecciones estacionales. GET /api/assets/top */
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

// Datos centralizados para megamenú (público)
const SEASONAL_COLLECTIONS_BY_MONTH = {
    0: [
        { slug: 'desk-organization', labelEs: 'Organización de escritorio', labelEn: 'Desk Setup' },
        { slug: 'cable-management', labelEs: 'Gestión de cables', labelEn: 'Cable Management' },
        { slug: 'planner-accessories', labelEs: 'Accesorios de agenda', labelEn: 'Planner Accessories' },
        { slug: 'home-organization', labelEs: 'Organización del hogar', labelEn: 'Home Organization' },
        { slug: 'phone-stands', labelEs: 'Soportes para celular', labelEn: 'Phone Stands' },
        { slug: 'storage-solutions', labelEs: 'Soluciones de almacenamiento', labelEn: 'Storage Solutions' },
    ],
    1: [
        { slug: 'valentines-day', labelEs: 'San Valentín', labelEn: "Valentine's" },
        { slug: 'heart-cookie-cutters', labelEs: 'Cortadores corazón', labelEn: 'Heart Cutters' },
        { slug: 'gift-boxes', labelEs: 'Cajas de regalo', labelEn: 'Gift Boxes' },
        { slug: 'romantic-lithophanes', labelEs: 'Litofanías románticas', labelEn: 'Romantic Lithophanes' },
        { slug: 'rose-vases', labelEs: 'Floreros', labelEn: 'Rose Vases' },
        { slug: 'couples-keychains', labelEs: 'Llaveros de pareja', labelEn: 'Couple Keychains' },
    ],
    2: [
        { slug: 'planters', labelEs: 'Macetas', labelEn: 'Planters' },
        { slug: 'seed-starters', labelEs: 'Germinadores', labelEn: 'Seed Starters' },
        { slug: 'garden-tools', labelEs: 'Herramientas de jardín', labelEn: 'Garden Tools' },
        { slug: 'easter-prep', labelEs: 'Pre-Pascua', labelEn: 'Easter Prep' },
        { slug: 'desk-planters', labelEs: 'Macetas de escritorio', labelEn: 'Desk Planters' },
        { slug: 'spring-home-decor', labelEs: 'Decoración de primavera', labelEn: 'Spring Decor' },
    ],
    3: [
        { slug: 'easter', labelEs: 'Pascua', labelEn: 'Easter' },
        { slug: 'bunny-decor', labelEs: 'Decoración conejo', labelEn: 'Bunny Decor' },
        { slug: 'egg-holders', labelEs: 'Porta huevos', labelEn: 'Egg Holders' },
        { slug: 'easter-cookie-cutters', labelEs: 'Cortadores de Pascua', labelEn: 'Easter Cutters' },
        { slug: 'family-boardgame-accessories', labelEs: 'Accesorios juegos de mesa', labelEn: 'Boardgame Accessories' },
        { slug: 'spring-tabletop-decor', labelEs: 'Decoración de mesa', labelEn: 'Table Decor' },
    ],
    4: [
        { slug: 'star-wars', labelEs: 'Cultura Geek', labelEn: 'Geek Culture' },
        { slug: 'star-wars-inspired', labelEs: 'Inspirado Sci-Fi', labelEn: 'Sci-Fi Inspired' },
        { slug: 'miniatures-display', labelEs: 'Exhibidores miniaturas', labelEn: 'Mini Display' },
        { slug: 'mothers-day-gifts', labelEs: 'Regalos Día de la Madre', labelEn: "Mother's Day Gifts" },
        { slug: 'decorative-vases', labelEs: 'Floreros decorativos', labelEn: 'Decorative Vases' },
        { slug: 'wall-art-panels', labelEs: 'Paneles decorativos', labelEn: 'Wall Art Panels' },
    ],
    5: [
        { slug: 'fathers-day', labelEs: 'Día del Padre', labelEn: "Father's Day" },
        { slug: 'tool-organizers', labelEs: 'Organizadores de herramientas', labelEn: 'Tool Organizers' },
        { slug: 'workshop-accessories', labelEs: 'Accesorios de taller', labelEn: 'Workshop Accessories' },
        { slug: 'desk-gadgets', labelEs: 'Gadgets de escritorio', labelEn: 'Desk Gadgets' },
        { slug: 'bottle-openers', labelEs: 'Destapadores', labelEn: 'Bottle Openers' },
        { slug: 'car-accessories', labelEs: 'Accesorios de carro', labelEn: 'Car Accessories' },
    ],
    6: [
        { slug: 'cosplay', labelEs: 'Cosplay & Props', labelEn: 'Cosplay' },
        { slug: 'costume-props', labelEs: 'Props de vestuario', labelEn: 'Costume Props' },
        { slug: 'helmet-stands', labelEs: 'Soportes para cascos', labelEn: 'Helmet Stands' },
        { slug: 'armor-accessories', labelEs: 'Accesorios de armadura', labelEn: 'Armor Accessories' },
        { slug: 'miniatures-painting-tools', labelEs: 'Herramientas para pintar minis', labelEn: 'Mini Painting Tools' },
        { slug: 'convention-gear', labelEs: 'Accesorios para eventos', labelEn: 'Convention Gear' },
    ],
    7: [
        { slug: 'back-to-school', labelEs: 'Regreso a clases', labelEn: 'Back to School' },
        { slug: 'pencil-holders', labelEs: 'Portalápices', labelEn: 'Pencil Holders' },
        { slug: 'laptop-stands', labelEs: 'Soportes laptop', labelEn: 'Laptop Stands' },
        { slug: 'study-organizers', labelEs: 'Organizadores de estudio', labelEn: 'Study Organizers' },
        { slug: 'bookmark-designs', labelEs: 'Separadores', labelEn: 'Bookmarks' },
        { slug: 'backpack-clips', labelEs: 'Clips para mochila', labelEn: 'Backpack Clips' },
    ],
    8: [
        { slug: 'back-to-school', labelEs: 'Regreso a clases', labelEn: 'Back to School' },
        { slug: 'productivity-desk', labelEs: 'Productividad escritorio', labelEn: 'Desk Productivity' },
        { slug: 'headphone-stands', labelEs: 'Soportes audífonos', labelEn: 'Headphone Stands' },
        { slug: 'cable-management', labelEs: 'Gestión de cables', labelEn: 'Cable Management' },
        { slug: 'office-mini-storage', labelEs: 'Mini almacenamiento oficina', labelEn: 'Office Mini Storage' },
        { slug: 'halloween-prep', labelEs: 'Pre-Halloween', labelEn: 'Halloween Prep' },
    ],
    9: [
        { slug: 'halloween', labelEs: 'Halloween', labelEn: 'Halloween' },
        { slug: 'spooky-decor', labelEs: 'Decoración spooky', labelEn: 'Spooky Decor' },
        { slug: 'mask-designs', labelEs: 'Máscaras', labelEn: 'Mask Designs' },
        { slug: 'pumpkin-lanterns', labelEs: 'Calabazas y faroles', labelEn: 'Pumpkin Lanterns' },
        { slug: 'halloween-cookie-cutters', labelEs: 'Cortadores Halloween', labelEn: 'Halloween Cutters' },
        { slug: 'candy-bowls', labelEs: 'Bowl dulces', labelEn: 'Candy Bowls' },
    ],
    10: [
        { slug: '3d-printer-upgrades', labelEs: 'Mejoras 3D', labelEn: 'Printer Upgrades' },
        { slug: 'filament-storage', labelEs: 'Almacenamiento filamento', labelEn: 'Filament Storage' },
        { slug: 'nozzle-tools', labelEs: 'Herramientas de boquillas', labelEn: 'Nozzle Tools' },
        { slug: 'calibration-jigs', labelEs: 'Útiles de calibración', labelEn: 'Calibration Jigs' },
        { slug: 'workshop-organization', labelEs: 'Organización taller', labelEn: 'Workshop Organization' },
        { slug: 'black-friday-gifts', labelEs: 'Regalos tech', labelEn: 'Tech Gifts' },
    ],
    11: [
        { slug: 'christmas', labelEs: 'Navidad', labelEn: 'Christmas' },
        { slug: 'tree-ornaments', labelEs: 'Adornos árbol', labelEn: 'Tree Ornaments' },
        { slug: 'nativity-scene', labelEs: 'Pesebre', labelEn: 'Nativity' },
        { slug: 'gift-tags', labelEs: 'Etiquetas regalo', labelEn: 'Gift Tags' },
        { slug: 'christmas-cookie-cutters', labelEs: 'Cortadores navideños', labelEn: 'Christmas Cutters' },
        { slug: 'advent-calendar', labelEs: 'Calendario de adviento', labelEn: 'Advent Calendar' },
    ],
};

/** Normalizar token de búsqueda para matching. */
function normalizeToken(v) {
    return String(v || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-');
}

/** Generar colecciones temáticas estacionales según el mes actual. */
export function getSeasonalCollections(month = new Date().getMonth()) {
    const m = Number(month);
    if (!Number.isFinite(m)) return [];
    return (SEASONAL_COLLECTIONS_BY_MONTH[m] || []).map((it) => ({ ...it }));
}

/** Construir colecciones estacionales enriquecidas con datos de Qdrant. */
function buildSeasonalCollectionsFromQdrant(baseCollections, orderedAssets) {
    const perCategoryCap = 2;
    const maxEvidenceAssets = 60;
    const diversityCounter = new Map();
    const evidenceAssets = [];

    for (const asset of orderedAssets || []) {
        const primaryCategory = normalizeToken(
            asset?.categories?.[0]?.slug || asset?.categories?.[0]?.slugEn || 'uncategorized'
        );
        const used = diversityCounter.get(primaryCategory) || 0;
        if (used >= perCategoryCap) continue;

        diversityCounter.set(primaryCategory, used + 1);
        evidenceAssets.push(asset);
        if (evidenceAssets.length >= maxEvidenceAssets) break;
    }

    const scoreBySlug = new Map(baseCollections.map((it) => [normalizeToken(it.slug), 0]));

    evidenceAssets.forEach((asset, idx) => {
        const weight = Math.max(1, 60 - idx);
        const slugBag = new Set();

        for (const c of asset?.categories || []) {
            slugBag.add(normalizeToken(c?.slug));
            slugBag.add(normalizeToken(c?.slugEn));
        }
        for (const t of asset?.tags || []) {
            slugBag.add(normalizeToken(t?.slug));
            slugBag.add(normalizeToken(t?.slugEn));
        }

        for (const base of baseCollections) {
            const key = normalizeToken(base.slug);
            if (!key) continue;
            if (slugBag.has(key)) {
                scoreBySlug.set(key, (scoreBySlug.get(key) || 0) + weight);
            }
        }
    });

    const withScore = baseCollections.map((it, index) => ({
        ...it,
        score: scoreBySlug.get(normalizeToken(it.slug)) || 0,
        _index: index,
    }));

    withScore.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a._index - b._index;
    });

    return withScore.slice(0, 6).map(({ _index, ...rest }) => rest);
}

/** Datos para el mega menú: categorías con conteo de assets y assets destacados. GET /api/assets/menu/mega */
export const getMegaMenuData = async (_req, res) => {
    try {
        const [categories, mostDownloaded] = await Promise.all([
            prisma.category.findMany({
                orderBy: { name: 'asc' },
                select: {
                    id: true,
                    name: true,
                    nameEn: true,
                    slug: true,
                    slugEn: true,
                },
            }),
            prisma.asset.findMany({
                where: { status: 'PUBLISHED' },
                orderBy: [{ downloads: 'desc' }, { id: 'desc' }],
                take: 8,
                select: {
                    id: true,
                    slug: true,
                    title: true,
                    titleEn: true,
                    downloads: true,
                    isPremium: true,
                },
            }),
        ]);

        const seasonalBase = getSeasonalCollections(new Date().getMonth());
        let seasonalCollections = seasonalBase;

        if (seasonalBase.length) {
            const seasonalQuery = seasonalBase
                .map((it) => `${it.labelEs} ${it.labelEn} ${it.slug}`)
                .join(' | ');

            const aiResults = await qdrantMultimodalService.searchByImage(null, null, seasonalQuery, 60);
            const idsOrdered = [];
            const seen = new Set();

            for (const hit of aiResults || []) {
                const id = Number(hit?.id);
                if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
                seen.add(id);
                idsOrdered.push(id);
                if (idsOrdered.length >= 60) break;
            }

            if (idsOrdered.length) {
                const assets = await prisma.asset.findMany({
                    where: { id: { in: idsOrdered }, status: 'PUBLISHED' },
                    select: {
                        id: true,
                        categories: {
                            select: {
                                slug: true,
                                slugEn: true,
                            },
                        },
                        tags: {
                            select: {
                                slug: true,
                                slugEn: true,
                            },
                        },
                    },
                });

                const byId = new Map(assets.map((a) => [Number(a.id), a]));
                const orderedAssets = idsOrdered
                    .map((id) => byId.get(id))
                    .filter(Boolean);

                seasonalCollections = buildSeasonalCollectionsFromQdrant(seasonalBase, orderedAssets);
            }
        }

        return res.json({ categories, mostDownloaded, seasonalCollections });
    } catch (e) {
        console.error('[ASSETS] megaMenuData error:', e);
        return res.status(500).json({ message: 'Error getting mega menu data' });
    }
};

/** Búsqueda pública de assets con scoring, filtros por categoría/tag, ordenamiento y paginación. GET /api/assets/search */
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

            const aiResults = await qdrantMultimodalService.searchByImage(null, null, qStr, aiLimit);
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

/** Solicitar descarga de un asset: verifica suscripción, registra historial, retorna link MEGA. POST /api/assets/:id/request-download */
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

/** Obtener un asset por su slug con verificación opcional de link MEGA. GET /api/assets/slug/:slug */
export const getAssetBySlug = async (req, res) => {


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
                // Descripción ESTABLE: no depende de isPremium para evitar que el cron de
                // freebies cause variación diaria de contenido (perjudica indexación SEO).
                const intro = `Descarga el archivo STL de "${titular}" listo para impresión 3D.`;
                const cat = primaryCategoryEs ? ` Categoría: ${primaryCategoryEs}.` : '';
                const tags = tagsSnippetEs ? ` Tags: ${tagsSnippetEs}.` : '';
                const cierre = ' Compatible con impresoras FDM y de Resina. Disponible en STLHUB vía MEGA.';
                let full = intro + cat + tags + cierre;
                // Limitar a ~300 chars para evitar exceso en meta description
                if (full.length > 300) full = full.slice(0, 297).replace(/[,.;:!\s]+$/,'') + '...';
                return full;
            }
            function buildDescriptionEn() {
                const titular = normTitleEn || safe.slug;
                // Stable description: does NOT depend on isPremium to avoid daily content
                // changes caused by the freebies cron (which hurts SEO indexation).
                const intro = `Download the STL file for "${titular}" ready for 3D printing.`;
                const cat = primaryCategoryEn ? ` Category: ${primaryCategoryEn}.` : '';
                const tags = tagsSnippetEn ? ` Tags: ${tagsSnippetEn}.` : '';
                const cierre = ' Compatible with FDM and Resin printers. Available on STLHUB via MEGA.';
                let full = intro + cat + tags + cierre;
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

/** Listar todos los slugs de assets publicados (para sitemap/SSG). GET /api/assets/slugs */
export const listPublishedSlugs = async (req, res) => {
    try {
        const { updatedAfter } = req.query || {};
        const where = { status: 'PUBLISHED' };
        if (updatedAfter) {
            const d = new Date(updatedAfter);
            if (!isNaN(d.getTime())) where.updatedAt = { gt: d };
        }
        const limit = req.query.limit ? Math.min(Number(req.query.limit) || 50000, 50000) : 50000;
        const rows = await prisma.asset.findMany({
            where,
            select: { slug: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' }, // más recientes primero
            take: limit,
        });
        return res.json(rows);
    } catch (e) {
        console.error('[ASSETS] listPublishedSlugs error:', e);
        return res.status(500).json({ message: 'Error listing slugs' });
    }
};

/** Aleatorizar qué assets son gratuitos según el límite configurado. POST /api/assets/randomize-free */
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


/** Restaurar link de descarga de un asset desde cuentas MEGA de backup. POST /api/assets/:assetId/restore-link */
export async function restoreAssetFromBackup(req, res) {
  const assetId = Number(req.params.assetId ?? req.body?.assetId);
  const preferBackupAccountId = req.body?.backupId ? Number(req.body.backupId) : null;

  if (!Number.isFinite(assetId) || assetId <= 0) {
    return res.status(400).json({ message: 'Invalid asset id' });
  }

  // Auto-accept MEGA terms/EULA prompts in child processes
  function attachAutoAcceptTerms(child, label = 'MEGA') {
      const EOL = '\n';
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
              actions.push(['yes' + EOL, 'fallback-eula']);
              lastPromptAt = now;
          }

          actions.forEach(([txt, why], i) => {
              setTimeout(() => {
                  const since = Date.now() - lastAnsweredAt;
                  if (since < 80) {
                      setTimeout(() => safeWrite(txt, why), 100 - since);
                  } else {
                      safeWrite(txt, why);
                  }
              }, i * 80);
          });

          if (sawChoicePrompt) {
              setTimeout(() => {
                  const since = Date.now() - lastAnsweredAt;
                  if (since > 550) {
                      const choice = PROMPT_YNA.test(s) ? 'a' : 'y';
                      safeWrite(choice + EOL, 'failsafe-choice');
                  }
              }, 600);
          }

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

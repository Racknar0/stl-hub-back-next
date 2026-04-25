import { PrismaClient } from '@prisma/client';
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const qdrantHost = process.env.QDRANT_HOST || '127.0.0.1';
const qdrantPort = Number(process.env.QDRANT_PORT || 6333);
const qdrantCollection = process.env.QDRANT_MULTIMODAL_COLLECTION || 'stls-multimodal';
const geminiEmbeddingModel = process.env.GEMINI_MULTIMODAL_EMBEDDING_MODEL || 'gemini-embedding-2';
// Usamos process.cwd() si no está definido para resolver el path de uploads localmente
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
const MULTIMODAL_DIMENSIONS = 3072;

const qdrant = new QdrantClient({ host: qdrantHost, port: qdrantPort });
let ai = null;
if (geminiApiKey) {
  // Ajuste según versión de SDK de GoogleGenAI
  ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { apiVersion: 'v1alpha' } });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IMAGE_MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
};

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

function collectAssetImagePaths(asset, limit = 5) {
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
        if (out.length >= limit) break;
    }

    return out;
}

function getImageMimeType(filePath) {
    return IMAGE_MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] || null;
}

const ensureCollectionExists = async () => {
  try {
    await qdrant.getCollection(qdrantCollection);
    return;
  } catch {
    await qdrant.createCollection(qdrantCollection, {
      vectors: {
        size: MULTIMODAL_DIMENSIONS,
        distance: 'Cosine'
      }
    });
    console.warn(`[QDRANT MULTIMODAL] Coleccion '${qdrantCollection}' creada automáticamente (size=${MULTIMODAL_DIMENSIONS}).`);
  }
};

export const generateMultimodalVectorText = (asset) => {
  const titleEs = String(asset.title || '').trim() || 'Sin título';
  const titleEn = String(asset.titleEn || asset.title || '').trim() || 'Untitled';

  const descEs = String(asset.description || '').trim() || 'Sin descripción';
  const descEn = String(asset.descriptionEn || asset.description || '').trim() || 'No description';

  const catsEs = asset.categories && asset.categories.length > 0
    ? asset.categories.map(c => c.name).filter(Boolean).join(', ')
    : 'Sin categoría';

  const catsEn = asset.categories && asset.categories.length > 0
    ? asset.categories.map(c => c.nameEn || c.name).filter(Boolean).join(', ')
    : 'No category';

  const tagsEs = asset.tags && asset.tags.length > 0
    ? asset.tags.map(t => t.name).filter(Boolean).join(', ')
    : 'Sin tags';

  const tagsEn = asset.tags && asset.tags.length > 0
    ? asset.tags.map(t => t.nameEn || t.name).filter(Boolean).join(', ')
    : 'No tags';

  return [
    `Título (ES): ${titleEs}.`,
    `Title (EN): ${titleEn}.`,
    `Categorías (ES): ${catsEs}.`,
    `Categories (EN): ${catsEn}.`,
    `Tags (ES): ${tagsEs}.`,
    `Tags (EN): ${tagsEn}.`,
    `Descripción (ES): ${descEs}.`,
    `Description (EN): ${descEn}.`
  ].join(' ');
};

export const upsertAssetMultimodalVector = async (assetId, options = {}) => {
  if (!ai) {
    console.warn(`[QDRANT MULTIMODAL] Saltando vectorizacion de asset ${assetId}: Falta GEMINI_API_KEY`);
    return false;
  }

  try {
    const asset = await prisma.asset.findUnique({
      where: { id: Number(assetId) },
      include: { 
        categories: true, 
        tags: true 
      }
    });

    if (!asset) {
      console.warn(`[QDRANT MULTIMODAL] Asset ${assetId} no existe en DB`);
      return false;
    }

    // 1. Preparar texto
    const textoCompleto = generateMultimodalVectorText(asset);
    
    // 2. Preparar imágenes
    const relPaths = collectAssetImagePaths(asset, 5);
    const contentsArr = [{ text: textoCompleto }];
    
    const uiImages = []; // Para el payload

    for (const rel of relPaths) {
        const abs = path.join(UPLOADS_DIR, rel);
        const mimeType = getImageMimeType(abs);
        if (!mimeType || !fs.existsSync(abs)) continue;

        try {
            const base64Data = fs.readFileSync(abs).toString('base64');
            contentsArr.push({
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            });
            uiImages.push(`/uploads/${rel.replace(/\\/g, '/')}`);
        } catch (err) {
            console.warn(`[QDRANT MULTIMODAL] Error leyendo imagen ${rel}:`, err?.message);
        }
    }

    // Extraer variables para payload optimizado
    const titleEs = String(asset.title || '').trim() || 'Sin título';
    const titleEn = String(asset.titleEn || asset.title || '').trim() || 'Untitled';
    const descEs = String(asset.description || '').trim() || 'Sin descripción';
    const descEn = String(asset.descriptionEn || asset.description || '').trim() || 'No description';
    const categorySlugs = Array.isArray(asset.categories) ? asset.categories.map(c => String(c.slug || '').trim()).filter(Boolean) : [];
    const categorySlugsEn = Array.isArray(asset.categories) ? asset.categories.map(c => String(c.slugEn || '').trim()).filter(Boolean) : [];
    const tagSlugs = Array.isArray(asset.tags) ? asset.tags.map(t => String(t.slug || '').trim()).filter(Boolean) : [];
    const tagSlugsEn = Array.isArray(asset.tags) ? asset.tags.map(t => String(t.slugEn || '').trim()).filter(Boolean) : [];

    // 3. Llamar a Gemini Embed 2
    try {
        const response = await ai.models.embedContent({
            model: geminiEmbeddingModel,
            contents: contentsArr,
            outputDimensionality: MULTIMODAL_DIMENSIONS // Forzar 3072
        });

        const vector = response?.embeddings?.[0]?.values;
        if (!Array.isArray(vector) || vector.length === 0) {
            throw new Error('Gemini no devolvio embedding valido multimodal');
        }

        await ensureCollectionExists();

        // 4. Upsert en Qdrant (stls-multimodal)
        await qdrant.upsert(qdrantCollection, {
            wait: true,
            points: [{
                id: asset.id,
                vector: vector,
                payload: {
                    title: titleEs,
                    titleEn: titleEn,
                    slug: asset.slug,
                    description: descEs,
                    descriptionEn: descEn,
                    images: uiImages,
                    categorySlugs,
                    categorySlugsEn,
                    tagSlugs,
                    tagSlugsEn,
                    isPremium: Boolean(asset.isPremium),
                    createdAt: asset.createdAt ? new Date(asset.createdAt).toISOString() : null,
                }
            }]
        });

        console.log(`[QDRANT MULTIMODAL] Vector actualizado exitosamente para Asset ${assetId}`);
        return true;
    } catch (error) {
        console.error(`[QDRANT MULTIMODAL] Error de API/Qdrant para Asset ${assetId}:`, error?.message || error);
        return false;
    }

  } catch (error) {
    console.error(`[QDRANT MULTIMODAL] Error general para Asset ${assetId}:`, error?.message || error);
    return false;
  }
};

export const deleteAssetMultimodalVector = async (assetId) => {
  try {
    await qdrant.delete(qdrantCollection, {
      points: [Number(assetId)],
      wait: true
    });
    return true;
  } catch (error) {
    console.error(`[QDRANT MULTIMODAL] Error borrando vector para Asset ${assetId}:`, error?.message || error);
    return false;
  }
};

export const getMultimodalSyncStatus = async () => {
    try {
        const dbCount = await prisma.asset.count({
            where: { status: 'PUBLISHED' } // Solo publicados o los que consideres activos
        });

        let qdrantCount = 0;
        try {
            const collectionInfo = await qdrant.getCollection(qdrantCollection);
            qdrantCount = collectionInfo?.points_count || collectionInfo?.vectors_count || 0;
        } catch {
            qdrantCount = 0;
        }

        return {
            dbCount,
            qdrantCount,
            estimatedMissing: Math.max(0, dbCount - qdrantCount)
        };
    } catch (error) {
        console.error('[QDRANT MULTIMODAL] Error obteniendo status:', error);
        return { dbCount: 0, qdrantCount: 0, estimatedMissing: 0 };
    }
};

export const searchByImage = async (imageBuffer, mimeType, textContext = '', limit = 20) => {
  if (!ai) {
    throw new Error('GEMINI_API_KEY no configurada para búsqueda multimodal');
  }

  try {
    await ensureCollectionExists();

    // Build contents array: image + optional text
    const contentsArr = [];

    if (imageBuffer && mimeType) {
      const base64Data = imageBuffer.toString('base64');
      contentsArr.push({
        inlineData: {
          data: base64Data,
          mimeType: mimeType
        }
      });
    }

    const text = String(textContext || '').trim();
    if (text) {
      contentsArr.push({ text });
    }

    if (contentsArr.length === 0) {
      throw new Error('Se requiere al menos una imagen o texto para buscar');
    }

    // Generate embedding
    const response = await ai.models.embedContent({
      model: geminiEmbeddingModel,
      contents: contentsArr,
      outputDimensionality: MULTIMODAL_DIMENSIONS
    });

    const queryVector = response?.embeddings?.[0]?.values;
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      throw new Error('Gemini no devolvió embedding válido para la búsqueda');
    }

    // Query Qdrant
    const results = await qdrant.search(qdrantCollection, {
      vector: queryVector,
      limit: Math.min(200, Math.max(1, Number(limit) || 20)),
      with_payload: true,
      score_threshold: 0.3
    });

    return (results || []).map(r => ({
      id: r.id,
      score: Number(r.score || 0).toFixed(4),
      ...r.payload
    }));
  } catch (error) {
    console.error('[QDRANT MULTIMODAL] Error en searchByImage:', error?.message || error);
    throw error;
  }
};

export default {
  generateMultimodalVectorText,
  upsertAssetMultimodalVector,
  deleteAssetMultimodalVector,
  getMultimodalSyncStatus,
  searchByImage
};

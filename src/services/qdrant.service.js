import { PrismaClient } from '@prisma/client';
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';

const prisma = new PrismaClient();
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const qdrantHost = process.env.QDRANT_HOST || '127.0.0.1';
const qdrantPort = Number(process.env.QDRANT_PORT || 6333);
const qdrantCollection = process.env.QDRANT_COLLECTION || 'stls';
const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';

const qdrant = new QdrantClient({ host: qdrantHost, port: qdrantPort });
let ai = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({ apiKey: geminiApiKey });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getErrorStatus = (error) => {
  const status = Number(error?.status || error?.response?.status || error?.cause?.status);
  return Number.isFinite(status) ? status : null;
};

const formatErrorReason = (error) => {
  const base = String(error?.message || error || 'Error desconocido');
  const status = getErrorStatus(error);
  if (status) return `${base} (status ${status})`;
  return base;
};

const isRetryableVectorError = (error) => {
  const status = getErrorStatus(error);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;

  const txt = formatErrorReason(error).toLowerCase();
  const transientHints = [
    'network error',
    'fetch failed',
    'econnreset',
    'econnrefused',
    'etimedout',
    'timeout',
    'socket hang up',
    'tls',
    'temporary',
    'unavailable',
    'connection closed',
    'aborted',
  ];

  return transientHints.some((hint) => txt.includes(hint));
};

const ensureCollectionExists = async (vectorSize) => {
  try {
    await qdrant.getCollection(qdrantCollection);
    return;
  } catch {
    await qdrant.createCollection(qdrantCollection, {
      vectors: {
        size: Number(vectorSize),
        distance: 'Cosine'
      }
    });
    console.warn(`[QDRANT] Coleccion '${qdrantCollection}' creada automaticamente (size=${vectorSize}).`);
  }
};

export const generateAssetVectorText = (asset) => {
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

export const upsertAssetVector = async (assetId, options = {}) => {
  const includeError = Boolean(options?.includeError);
  const requestedRetries = Number(options?.maxRetries);
  const maxRetries = Number.isFinite(requestedRetries)
    ? Math.min(10, Math.max(1, Math.floor(requestedRetries)))
    : 1;

  if (!ai) {
    const reason = 'Falta GEMINI_API_KEY/GOOGLE_API_KEY en backend/.env';
    console.warn(`[QDRANT] Saltando vectorizacion del asset ${assetId}: ${reason}`);
    return includeError ? { ok: false, error: reason, attempts: 1 } : false;
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
      const reason = `Asset ${assetId} no existe en DB`;
      return includeError ? { ok: false, error: reason, attempts: 1 } : false;
    }

    const textoCompleto = generateAssetVectorText(asset);

    // Extraer variables para payload una sola vez.
    const titleEs = String(asset.title || '').trim() || 'Sin título';
    const titleEn = String(asset.titleEn || asset.title || '').trim() || 'Untitled';
    const categorySlugs = Array.isArray(asset.categories) ? asset.categories.map(c => String(c.slug || '').trim()).filter(Boolean) : [];
    const categorySlugsEn = Array.isArray(asset.categories) ? asset.categories.map(c => String(c.slugEn || '').trim()).filter(Boolean) : [];
    const tagSlugs = Array.isArray(asset.tags) ? asset.tags.map(t => String(t.slug || '').trim()).filter(Boolean) : [];
    const tagSlugsEn = Array.isArray(asset.tags) ? asset.tags.map(t => String(t.slugEn || '').trim()).filter(Boolean) : [];
    const hasDescriptionEs = Boolean(String(asset.description || '').trim());
    const hasDescriptionEn = Boolean(String(asset.descriptionEn || '').trim());

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.embedContent({
          model: geminiEmbeddingModel,
          contents: textoCompleto,
        });

        const vector = response?.embeddings?.[0]?.values;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error('Gemini no devolvio embedding valido');
        }

        await ensureCollectionExists(vector.length);

        await qdrant.upsert(qdrantCollection, {
          wait: true,
          points: [{
            id: asset.id,
            vector: vector,
            payload: {
              title: titleEs,
              titleEn: titleEn,
              slug: asset.slug,
              isPremium: Boolean(asset.isPremium),
              status: String(asset.status || ''),
              downloads: Number(asset.downloads || 0),
              createdAt: asset.createdAt ? new Date(asset.createdAt).toISOString() : null,
              updatedAt: asset.updatedAt ? new Date(asset.updatedAt).toISOString() : null,
              categorySlugs,
              categorySlugsEn,
              tagSlugs,
              tagSlugsEn,
              hasDescriptionEs,
              hasDescriptionEn
            }
          }]
        });

        return includeError ? { ok: true, attempts: attempt } : true;
      } catch (error) {
        const reason = formatErrorReason(error);
        const retryable = isRetryableVectorError(error);
        const canRetry = retryable && attempt < maxRetries;

        console.error(`[QDRANT] Error actualizando vector para Asset ${assetId} (intento ${attempt}/${maxRetries}):`, reason);

        if (canRetry) {
          const backoffMs = Math.min(2500, 350 * attempt);
          await sleep(backoffMs);
          continue;
        }

        return includeError
          ? {
              ok: false,
              error: reason,
              attempts: attempt,
              retryExhausted: retryable && attempt >= maxRetries,
            }
          : false;
      }
    }

    return includeError
      ? { ok: false, error: 'Fallo inesperado en reintentos', attempts: maxRetries, retryExhausted: true }
      : false;
  } catch (error) {
    const reason = formatErrorReason(error);
    console.error(`[QDRANT] Error actualizando vector para Asset ${assetId}:`, reason);
    return includeError ? { ok: false, error: reason, attempts: 1 } : false;
  }
};

export const deleteAssetVector = async (assetId) => {
  try {
    await qdrant.delete(qdrantCollection, {
      points: [Number(assetId)],
      wait: true
    });
    return true;
  } catch (error) {
    console.error(`[QDRANT] Error borrando vector para Asset ${assetId}:`, error?.message || error);
    return false;
  }
};

export const searchSimilarAssets = async (queryStr, limit = 50) => {
  if (!ai || !queryStr) return [];
  
  try {
    const response = await ai.models.embedContent({
      model: geminiEmbeddingModel,
      contents: queryStr,
    });
    const vectorBusqueda = response.embeddings[0].values;

    const resultados = await qdrant.search(qdrantCollection, {
      vector: vectorBusqueda,
      limit: Number(limit) || 50,
      with_payload: true
    });
    
    // Retorna array de matchers: { id, score, payload }
    return resultados;
  } catch (error) {
    console.error(`[QDRANT] Error buscando "${queryStr}":`, error?.message || error);
    return [];
  }
};

export default {
  generateAssetVectorText,
  upsertAssetVector,
  deleteAssetVector,
  searchSimilarAssets
};

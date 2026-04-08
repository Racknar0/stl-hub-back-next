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

  if (!ai) {
    const reason = 'Falta GEMINI_API_KEY/GOOGLE_API_KEY en backend/.env';
    console.warn(`[QDRANT] Saltando vectorizacion del asset ${assetId}: ${reason}`);
    return includeError ? { ok: false, error: reason } : false;
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
      return includeError ? { ok: false, error: reason } : false;
    }

    const textoCompleto = generateAssetVectorText(asset);
    
    // Generar vector
    const response = await ai.models.embedContent({
      model: geminiEmbeddingModel,
      contents: textoCompleto,
    });
    
    const vector = response?.embeddings?.[0]?.values;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Gemini no devolvio embedding valido');
    }

    await ensureCollectionExists(vector.length);

    // Extraer variables para payload
    const titleEs = String(asset.title || '').trim() || 'Sin título';
    const titleEn = String(asset.titleEn || asset.title || '').trim() || 'Untitled';
    const categorySlugs = Array.isArray(asset.categories) ? asset.categories.map(c => String(c.slug || '').trim()).filter(Boolean) : [];
    const categorySlugsEn = Array.isArray(asset.categories) ? asset.categories.map(c => String(c.slugEn || '').trim()).filter(Boolean) : [];
    const tagSlugs = Array.isArray(asset.tags) ? asset.tags.map(t => String(t.slug || '').trim()).filter(Boolean) : [];
    const tagSlugsEn = Array.isArray(asset.tags) ? asset.tags.map(t => String(t.slugEn || '').trim()).filter(Boolean) : [];
    const hasDescriptionEs = Boolean(String(asset.description || '').trim());
    const hasDescriptionEn = Boolean(String(asset.descriptionEn || '').trim());

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

    return includeError ? { ok: true } : true;
  } catch (error) {
    const reason = error?.message || String(error);
    console.error(`[QDRANT] Error actualizando vector para Asset ${assetId}:`, reason);
    return includeError ? { ok: false, error: reason } : false;
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

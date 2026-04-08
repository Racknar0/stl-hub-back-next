import { PrismaClient } from '@prisma/client';
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!geminiApiKey) {
  throw new Error('Falta GEMINI_API_KEY/GOOGLE_API_KEY en backend/.env');
}

const qdrantHost = process.env.QDRANT_HOST || '127.0.0.1';
const qdrantPort = Number(process.env.QDRANT_PORT || 6333);
const qdrantCollection = process.env.QDRANT_COLLECTION || 'stls';
const geminiEmbeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';

const prisma = new PrismaClient();
const qdrant = new QdrantClient({ host: qdrantHost, port: qdrantPort });

const ai = new GoogleGenAI({ apiKey: geminiApiKey });
const misDiezIds = [12910, 12909, 12862, 12803, 12661, 12574, 12431, 175, 181, 4438];

async function procesarDiezAssets() {
  console.log("🛠️ Iniciando procesamiento con logs profundos...\n");

  for (const id of misDiezIds) {
    try {
      const asset = await prisma.asset.findUnique({
        where: { id: id },
        include: { 
          categories: true, 
          tags: true 
        }
      });

      if (!asset) {
        console.log(`⚠️ ID ${id} no encontrado en la DB. Saltando...\n`);
        continue; 
      }

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

      const categorySlugs = Array.isArray(asset.categories)
        ? asset.categories.map(c => String(c.slug || '').trim()).filter(Boolean)
        : [];

      const categorySlugsEn = Array.isArray(asset.categories)
        ? asset.categories.map(c => String(c.slugEn || '').trim()).filter(Boolean)
        : [];

      const tagSlugs = Array.isArray(asset.tags)
        ? asset.tags.map(t => String(t.slug || '').trim()).filter(Boolean)
        : [];

      const tagSlugsEn = Array.isArray(asset.tags)
        ? asset.tags.map(t => String(t.slugEn || '').trim()).filter(Boolean)
        : [];

      const hasDescriptionEs = Boolean(String(asset.description || '').trim());
      const hasDescriptionEn = Boolean(String(asset.descriptionEn || '').trim());

      const textoCompleto = [
        `Título (ES): ${titleEs}.`,
        `Title (EN): ${titleEn}.`,
        `Categorías (ES): ${catsEs}.`,
        `Categories (EN): ${catsEn}.`,
        `Tags (ES): ${tagsEs}.`,
        `Tags (EN): ${tagsEn}.`,
        `Descripción (ES): ${descEs}.`,
        `Description (EN): ${descEn}.`
      ].join(' ');

      console.log(`⏳ Generando vector para ID ${id}: ${asset.title}...`);

      const response = await ai.models.embedContent({
        model: geminiEmbeddingModel,
        contents: textoCompleto,
      });
      
      const vector = response.embeddings[0].values; 

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

      console.log(`✅ Asset ${id} sincronizado con Qdrant con éxito.\n`);
      await new Promise(resolve => setTimeout(resolve, 1500));

    } catch (error) {
      console.error(`\n❌ ERROR AL PROCESAR EL ID ${id}:`);
      console.error("--------------------------------------------------");
      console.error("Mensaje corto:", error.message);
      
      // Imprimir el objeto de error completo con toda su profundidad
      console.error("\nObjeto de error completo:");
      console.dir(error, { depth: null, colors: true });

      // Algunos SDKs guardan la respuesta real de la API dentro de error.response
      if (error.response) {
        console.error("\nRespuesta HTTP embebida:");
        console.dir(error.response, { depth: null, colors: true });
        
        if (error.response.data) {
           console.error("\nData del error:", JSON.stringify(error.response.data, null, 2));
        }
      }
      console.error("--------------------------------------------------\n");
      
      // Rompemos el ciclo en el primer error para no spamear la consola y poder leerlo bien
      console.log("🛑 Deteniendo el script para analizar este error...");
      break; 
    }
  }

  await prisma.$disconnect();
}

procesarDiezAssets();
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

const prisma = new PrismaClient();
const qdrant = new QdrantClient({ host: '127.0.0.1', port: 6333 });

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

      const cats = asset.categories && asset.categories.length > 0 
        ? asset.categories.map(c => c.name).join(", ") 
        : "Sin categoría";
        
      const tags = asset.tags && asset.tags.length > 0 
        ? asset.tags.map(t => t.name).join(", ") 
        : "Sin tags";
        
      const textoCompleto = `Título: ${asset.title}. Categorías: ${cats}. Tags: ${tags}. Descripción: ${asset.description || 'Sin descripción'}`;

      console.log(`⏳ Generando vector para ID ${id}: ${asset.title}...`);

      const response = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: textoCompleto,
      });
      
      const vector = response.embeddings[0].values; 

      await qdrant.upsert('stls', {
        wait: true,
        points: [{
          id: asset.id,
          vector: vector,
          payload: {
            title: asset.title,
            slug: asset.slug
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
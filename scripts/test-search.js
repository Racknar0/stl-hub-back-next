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

const qdrant = new QdrantClient({ host: '127.0.0.1', port: 6333 });
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

function formatList(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(', ') : '---';
}

async function buscarEnStlHub(fraseUsuario) {
  console.log(`\n🔎 Buscando: "${fraseUsuario}"...\n`);

  try {
    // 1. Traducimos tu búsqueda a matemáticas (Vector de 3072 dimensiones)
    console.log("⏳ 1. La IA está convirtiendo tu frase a un vector...");
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: fraseUsuario,
    });
    const vectorBusqueda = response.embeddings[0].values;

    // 2. Buscamos en Qdrant los vectores más cercanos
    console.log("⏳ 2. Qdrant está buscando coincidencias matemáticas...");
    const resultados = await qdrant.search('stls', {
      vector: vectorBusqueda,
      limit: 3, // Queremos el Top 3 de resultados
      with_payload: true // Queremos que nos devuelva el título, no solo el ID
    });

    // 3. Mostramos los resultados bonitos
    console.log("\n🏆 TOP 3 MEJORES RESULTADOS:");
    resultados.forEach((res, index) => {
      // Qdrant devuelve el "score" (la coincidencia). Lo pasamos a porcentaje.
      const porcentaje = (res.score * 100).toFixed(1);
      const payload = res.payload || {};
      console.log(`\n${index + 1}. [${porcentaje}%] ID: ${res.id}`);
      console.log(`   Título ES: ${payload.title || '---'}`);
      console.log(`   Título EN: ${payload.titleEn || '---'}`);
      console.log(`   Slug: ${payload.slug || '---'}`);
      console.log(`   Premium: ${payload.isPremium ? 'Sí' : 'No'}`);
      console.log(`   Estado: ${payload.status || '---'}`);
      console.log(`   Descargas: ${Number(payload.downloads || 0)}`);
      console.log(`   Categorías ES: ${formatList(payload.categorySlugs)}`);
      console.log(`   Categorías EN: ${formatList(payload.categorySlugsEn)}`);
      console.log(`   Tags ES: ${formatList(payload.tagSlugs)}`);
      console.log(`   Tags EN: ${formatList(payload.tagSlugsEn)}`);
      console.log(`   Tiene descripción ES: ${payload.hasDescriptionEs ? 'Sí' : 'No'}`);
      console.log(`   Tiene descripción EN: ${payload.hasDescriptionEn ? 'Sí' : 'No'}`);
      console.log(`   Creado: ${payload.createdAt || '---'}`);
      console.log(`   Actualizado: ${payload.updatedAt || '---'}`);
    });

  } catch (error) {
    console.error("❌ Error en la búsqueda:", error);
  }
}

// =======================================================
// ¡HAZ TU PRUEBA AQUÍ!
// Vamos a buscar algo sin usar el nombre exacto del asset
// =======================================================
buscarEnStlHub("paisaje prehistórico con reptiles gigantes cazando");
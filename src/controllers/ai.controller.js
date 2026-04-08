import { PrismaClient } from '@prisma/client';
import { QdrantClient } from '@qdrant/js-client-rest';
import qdrantService from '../services/qdrant.service.js';

const prisma = new PrismaClient();
const qdrantHost = process.env.QDRANT_HOST || '127.0.0.1';
const qdrantPort = Number(process.env.QDRANT_PORT || 6333);
const qdrantCollection = process.env.QDRANT_COLLECTION || 'stls';

const qdrant = new QdrantClient({ host: qdrantHost, port: qdrantPort });

export const getVectorSyncStatus = async (req, res) => {
  try {
    // Assets válidos que deberían estar en Qdrant
    const dbAssetsCount = await prisma.asset.count({
        // Solo assets publicados participan en búsqueda pública/IA.
        where: { status: 'PUBLISHED' }
    });
    
    let qdrantCount = 0;
    try {
        const qCount = await qdrant.count(qdrantCollection);
        qdrantCount = qCount.count;
    } catch {
        // En caso de que la colección no exista aún
        qdrantCount = 0;
    }

    const estimatedMissing = Math.max(0, dbAssetsCount - qdrantCount);

    return res.json({
        dbCount: dbAssetsCount,
        qdrantCount: qdrantCount,
        estimatedMissing: estimatedMissing
    });
  } catch (error) {
    console.error('[AI] Error obteniendo status:', error);
    return res.status(500).json({ message: 'Error interno obteniendo estado' });
  }
};

export const syncMissingVectors = async (req, res) => {
    const requestedLimit = Number(req.body?.limit);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(1000, Math.max(1, Math.floor(requestedLimit)))
        : 10;
    
    // We will use Server-Sent Events (SSE) to stream logs
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // flush the headers to establish SSE

    const logAndSend = (msg) => {
        const time = new Date().toLocaleTimeString();
        const output = `[${time}] ${msg}`;
        res.write(`data: ${JSON.stringify({ message: output })}\n\n`);
    };

    try {
        logAndSend('Iniciando escaneo de base de datos...');
        
        // Obtener todos los IDs de la base de datos
        const allAssets = await prisma.asset.findMany({
            // Solo sincronizamos vectores de assets publicados.
            where: { status: 'PUBLISHED' },
            select: { id: true, title: true }
        });
        const dbIds = allAssets.map(a => a.id);
        
        logAndSend(`Validando estado de colección '${qdrantCollection}' en Qdrant...`);
        let missingIds = [];
        
        // Iteramos en chunks para no saturar retrieve
        let qdrantExistingIds = new Set();
        try {
            const chunkSize = 1000;
            for(let i=0; i<dbIds.length; i+=chunkSize){
                const chunk = dbIds.slice(i, i+chunkSize);
                const points = await qdrant.retrieve(qdrantCollection, { ids: chunk, with_payload: false, with_vector: false });
                points.forEach(p => qdrantExistingIds.add(Number(p.id)));
            }
        } catch(e) {
            logAndSend(`Error o colección inexistente, asumiendo vacío. Motivo: ${e?.message || 'sin detalle'}`);
        }

        missingIds = dbIds.filter(id => !qdrantExistingIds.has(id));

        logAndSend(`Se detectaron ${missingIds.length} vectores faltantes en total.`);
        
        const toProcess = missingIds.slice(0, limit);
        logAndSend(`Sincronizando ${toProcess.length} vectores en esta corrida...`);

        let successCount = 0;
        let failCount = 0;

        for (const id of toProcess) {
            const assetName = allAssets.find(a => a.id === id)?.title;
            logAndSend(`⏳ Vectorizando ID ${id}: ${assetName}...`);
            
            const result = await qdrantService.upsertAssetVector(id, {
                includeError: true,
                maxRetries: 10,
            });
            if (result?.ok) {
                if (Number(result?.attempts || 1) > 1) {
                    logAndSend(`🔁 ID ${id} sincronizado tras ${result.attempts} intentos.`);
                }
                logAndSend(`✅ ID ${id} sincronizado exitosamente.`);
                successCount++;
            } else {
                const attempts = Number(result?.attempts || 1);
                logAndSend(`❌ Error al sincronizar ID ${id} tras ${attempts} intento(s): ${result?.error || 'error desconocido'}`);
                failCount++;

                if (result?.retryExhausted) {
                    logAndSend(`🛑 Se corta la corrida: el ID ${id} agotó 10 reintentos por error de red/servicio.`);
                    break;
                }
            }

            // Pequeña pausa para no saturar la API
            await new Promise(r => setTimeout(r, 1000));
        }

        logAndSend(`🎉 Sincronización terminada. Éxito: ${successCount}, Errores: ${failCount}.`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (error) {
        logAndSend(`❌ Error fatal: ${error.message}`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    }
};

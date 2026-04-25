import { PrismaClient } from '@prisma/client';
import { QdrantClient } from '@qdrant/js-client-rest';
import qdrantMultimodalService from '../services/qdrantMultimodal.service.js';

const prisma = new PrismaClient();
const qdrantHost = process.env.QDRANT_HOST || '127.0.0.1';
const qdrantPort = Number(process.env.QDRANT_PORT || 6333);
const qdrantCollection = process.env.QDRANT_MULTIMODAL_COLLECTION || 'stls-multimodal';

const qdrant = new QdrantClient({ host: qdrantHost, port: qdrantPort });

export const getMultimodalVectorSyncStatus = async (req, res) => {
  try {
    const status = await qdrantMultimodalService.getMultimodalSyncStatus();
    return res.json(status);
  } catch (error) {
    console.error('[AI MULTIMODAL] Error obteniendo status:', error);
    return res.status(500).json({ message: 'Error interno obteniendo estado multimodal' });
  }
};

export const syncMissingMultimodalVectors = async (req, res) => {
    const requestedLimit = Number(req.body?.limit);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(1000, Math.max(1, Math.floor(requestedLimit)))
        : 10;
    
    // We will use Server-Sent Events (SSE) to stream logs
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const logAndSend = (msg) => {
        const time = new Date().toLocaleTimeString();
        const output = `[${time}] ${msg}`;
        res.write(`data: ${JSON.stringify({ message: output })}\n\n`);
    };

    try {
        logAndSend('Iniciando escaneo de base de datos para Multimodal...');
        
        const allAssets = await prisma.asset.findMany({
            where: { status: 'PUBLISHED' },
            select: { id: true, title: true }
        });
        const dbIds = allAssets.map(a => a.id);
        
        logAndSend(`Validando estado de colección '${qdrantCollection}' en Qdrant...`);
        let missingIds = [];
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

        logAndSend(`Se detectaron ${missingIds.length} vectores multimodales faltantes.`);
        
        const toProcess = missingIds.slice(0, limit);
        logAndSend(`Sincronizando ${toProcess.length} vectores en esta corrida...`);

        let successCount = 0;
        let failCount = 0;

        for (const id of toProcess) {
            const assetName = allAssets.find(a => a.id === id)?.title;
            logAndSend(`⏳ Vectorizando ID ${id}: ${assetName}...`);
            
            const success = await qdrantMultimodalService.upsertAssetMultimodalVector(id);
            if (success) {
                logAndSend(`✅ ID ${id} sincronizado exitosamente.`);
                successCount++;
            } else {
                logAndSend(`❌ Error al sincronizar ID ${id}`);
                failCount++;
            }

            // Pausa mayor por procesar imágenes
            await new Promise(r => setTimeout(r, 2000));
        }

        logAndSend(`🎉 Sincronización multimodal terminada. Éxito: ${successCount}, Errores: ${failCount}.`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    } catch (error) {
        logAndSend(`❌ Error fatal: ${error.message}`);
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    }
};

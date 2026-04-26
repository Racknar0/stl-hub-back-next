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

        for (let i = 0; i < toProcess.length; i++) {
            const id = toProcess[i];
            const assetName = allAssets.find(a => a.id === id)?.title;
            logAndSend(`⏳ [${i + 1}/${toProcess.length}] Vectorizando ID ${id}: ${assetName}...`);
            
            let success = false;
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                success = await qdrantMultimodalService.upsertAssetMultimodalVector(id);
                if (success) {
                    logAndSend(`✅ [${i + 1}/${toProcess.length}] ID ${id} sincronizado.`);
                    successCount++;
                    break;
                }
                if (attempt < maxRetries) {
                    const backoffMs = attempt * 8000 + Math.random() * 4000;
                    logAndSend(`⏸️ [${i + 1}/${toProcess.length}] ID ${id} falló (intento ${attempt}/${maxRetries}). Reintentando en ${Math.round(backoffMs / 1000)}s...`);
                    await new Promise(r => setTimeout(r, backoffMs));
                } else {
                    logAndSend(`❌ [${i + 1}/${toProcess.length}] Error al sincronizar ID ${id} tras ${maxRetries} intentos`);
                    failCount++;
                }
            }

            // Pausa entre assets para respetar rate limits de Google
            await new Promise(r => setTimeout(r, 3000));
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

export const searchByImageHandler = async (req, res) => {
  try {
    const file = req.file;
    const textContext = String(req.body?.text || '').trim();
    const limit = Number(req.body?.limit) || 20;

    if (!file || !file.buffer) {
      return res.status(400).json({ message: 'Se requiere una imagen para buscar' });
    }

    const mimeType = file.mimetype || 'image/jpeg';
    const results = await qdrantMultimodalService.searchByImage(file.buffer, mimeType, textContext, limit);

    if (!results || results.length === 0) {
      return res.json({ items: [], total: 0 });
    }

    // Enrich with full DB data
    const ids = results.map(r => Number(r.id)).filter(n => Number.isFinite(n) && n > 0);
    const dbAssets = await prisma.asset.findMany({
      where: { id: { in: ids } },
      include: {
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
      }
    });

    const dbMap = new Map(dbAssets.map(a => [a.id, a]));

    const items = results.map(r => {
      const db = dbMap.get(Number(r.id));
      if (!db) return null;
      return {
        id: db.id,
        title: db.title,
        titleEn: db.titleEn,
        description: db.description,
        descriptionEn: db.descriptionEn,
        slug: db.slug,
        images: Array.isArray(db.images) ? db.images : [],
        categories: db.categories || [],
        tags: db.tags || [],
        tagsEs: (db.tags || []).map(t => t.name).filter(Boolean),
        tagsEn: (db.tags || []).map(t => t.nameEn || t.name).filter(Boolean),
        isPremium: Boolean(db.isPremium),
        createdAt: db.createdAt,
        archiveSizeB: typeof db.archiveSizeB === 'bigint' ? db.archiveSizeB.toString() : db.archiveSizeB,
        fileSizeB: typeof db.fileSizeB === 'bigint' ? db.fileSizeB.toString() : db.fileSizeB,
        _score: r.score,
      };
    }).filter(Boolean);

    return res.json({ items, total: items.length });
  } catch (error) {
    console.error('[AI MULTIMODAL] Error en búsqueda por imagen:', error?.message || error);
    return res.status(500).json({ message: error?.message || 'Error interno en búsqueda visual' });
  }
};

import fs from 'fs';
import path from 'path';

export const searchByLocalImageHandler = async (req, res) => {
  try {
    const imagePath = String(req.body?.imagePath || '').trim();
    const textContext = String(req.body?.textContext || '').trim();
    const limit = Number(req.body?.limit) || 8;

    if (!imagePath) {
      return res.status(400).json({ message: 'Se requiere una ruta de imagen (imagePath)' });
    }

    // Resolve absolute path safely within uploads directory
    const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
    
    // Normalize path to prevent directory traversal
    const relativePath = imagePath.replace(/^(\/|\\)+/, '').replace(/^uploads(\/|\\)/i, '');
    const absolutePath = path.resolve(UPLOADS_DIR, relativePath);

    if (!absolutePath.startsWith(path.resolve(UPLOADS_DIR))) {
        return res.status(403).json({ message: 'Ruta de imagen no permitida' });
    }

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ message: 'La imagen local no existe en el servidor' });
    }

    const imageBuffer = fs.readFileSync(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    };
    const mimeType = mimeTypes[ext] || 'image/jpeg';

    const results = await qdrantMultimodalService.searchByImage(imageBuffer, mimeType, textContext, limit);

    if (!results || results.length === 0) {
      return res.json({ items: [], total: 0 });
    }

    // Enrich with full DB data (same as normal search)
    const ids = results.map(r => Number(r.id)).filter(n => Number.isFinite(n) && n > 0);
    const dbAssets = await prisma.asset.findMany({
      where: { id: { in: ids } },
      include: {
        categories: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
        tags: { select: { id: true, name: true, nameEn: true, slug: true, slugEn: true } },
      }
    });

    const dbMap = new Map(dbAssets.map(a => [a.id, a]));

    const items = results.map(r => {
      const db = dbMap.get(Number(r.id));
      if (!db) return null;
      return {
        id: db.id,
        title: db.title,
        titleEn: db.titleEn,
        slug: db.slug,
        images: Array.isArray(db.images) ? db.images : [],
        categories: db.categories || [],
        tags: db.tags || [],
        tagsEs: (db.tags || []).map(t => t.name).filter(Boolean),
        tagsEn: (db.tags || []).map(t => t.nameEn || t.name).filter(Boolean),
        _score: r.score,
      };
    }).filter(Boolean);

    return res.json({ items, total: items.length });
  } catch (error) {
    console.error('[AI MULTIMODAL] Error en búsqueda por imagen local:', error?.message || error);
    return res.status(500).json({ message: error?.message || 'Error interno en búsqueda visual local' });
  }
};

export const getVisualSimilarGroupsBatch = async (req, res) => {
  try {
    const pageIndex = Number(req.query.pageIndex) || 0;
    const pageSize = Number(req.query.pageSize) || 50;
    const threshold = Number(req.query.threshold) || 85;

    const assets = await prisma.asset.findMany({
      skip: pageIndex * pageSize,
      take: pageSize,
      orderBy: { id: 'desc' },
      select: { id: true, title: true, images: true, accountId: true }
    });

    const totalAssetsInDb = await prisma.asset.count();

    if (assets.length === 0) {
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify({ groups: [], totalProcessed: 0, totalAssets: totalAssetsInDb }));
    }

    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const qdrant = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
      apiKey: process.env.QDRANT_API_KEY
    });
    const qdrantCollection = process.env.QDRANT_COLLECTION || 'stls-multimodal';

    const ignoredPairs = await prisma.assetSimilarIgnorePair.findMany();
    const ignoredSet = new Set(ignoredPairs.map(p => `${Math.min(p.assetAId, p.assetBId)}-${Math.max(p.assetAId, p.assetBId)}`));

    const groups = [];
    const processedIds = new Set();

    for (const asset of assets) {
      if (processedIds.has(asset.id)) continue;

      try {
        const results = await qdrant.recommend(qdrantCollection, {
          positive: [asset.id],
          limit: 10,
          score_threshold: threshold / 100,
          with_payload: true
        });

        if (results && results.length > 0) {
          const validMatches = results.filter(r => {
             const aId = Math.min(asset.id, Number(r.id));
             const bId = Math.max(asset.id, Number(r.id));
             return !ignoredSet.has(`${aId}-${bId}`);
          });

          if (validMatches.length > 0) {
            const matchIds = validMatches.map(r => Number(r.id));
            const allIdsInGroup = [asset.id, ...matchIds];
            
            const groupDbAssets = await prisma.asset.findMany({
               where: { id: { in: allIdsInGroup } },
               include: { account: { select: { alias: true } } }
            });
            const dbMap = new Map(groupDbAssets.map(a => [a.id, a]));

            const groupItems = [
              { asset: dbMap.get(asset.id), similarity: 100, distance: 0 },
              ...validMatches.map(r => ({
                 asset: dbMap.get(Number(r.id)),
                 similarity: Math.round(Number(r.score) * 100),
                 distance: Number(r.score).toFixed(4)
              })).filter(i => i.asset)
            ];

            if (groupItems.length > 1) {
              groups.push({
                 id: `group-vis-${asset.id}`,
                 signature: `visual-${asset.id}`,
                 confidence: Math.round(Number(validMatches[0].score) * 100),
                 items: groupItems
              });
              
              allIdsInGroup.forEach(id => processedIds.add(id));
            }
          }
        }
      } catch(e) {
         // recommend falla si el asset no está en Qdrant (aún no se han generado sus vectores)
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ groups, totalProcessed: assets.length, totalAssets: totalAssetsInDb }, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value
    ));

  } catch (error) {
    console.error('[AI MULTIMODAL] Visual Similar Batch Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ============================================================
// FULL VISUAL SIMILAR SCAN – Union-Find clustering via SSE
// ============================================================
export const fullVisualSimilarScan = async (req, res) => {
  const threshold = Number(req.query.threshold) || 90;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
  };

  try {
    // 1. Load all published assets
    const allAssets = await prisma.asset.findMany({
      where: { status: 'PUBLISHED' },
      select: { id: true, title: true, images: true, accountId: true },
      orderBy: { id: 'desc' },
    });
    const totalAssets = allAssets.length;
    send({ type: 'init', totalAssets });

    if (totalAssets === 0) {
      send({ type: 'done', groups: [], totalAssets: 0 });
      return res.end();
    }

    // 2. Load ignored pairs
    const ignoredPairs = await prisma.assetSimilarIgnorePair.findMany();
    const ignoredSet = new Set(
      ignoredPairs.map(p => `${Math.min(p.assetAId, p.assetBId)}-${Math.max(p.assetAId, p.assetBId)}`)
    );

    // 3. Qdrant client
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
      apiKey: process.env.QDRANT_API_KEY,
    });
    const collection = process.env.QDRANT_COLLECTION || 'stls-multimodal';

    // 4. Union-Find structure
    const parent = new Map();
    const rank = new Map();

    function find(x) {
      if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); }
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x))); // path compression
        x = parent.get(x);
      }
      return x;
    }

    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      const rkA = rank.get(ra);
      const rkB = rank.get(rb);
      if (rkA < rkB) { parent.set(ra, rb); }
      else if (rkA > rkB) { parent.set(rb, ra); }
      else { parent.set(rb, ra); rank.set(ra, rkA + 1); }
    }

    // 5. Store similarity scores per pair
    const pairScores = new Map(); // "minId-maxId" -> score

    // 6. Scan every asset against Qdrant
    const scoreThreshold = threshold / 100;

    for (let i = 0; i < totalAssets; i++) {
      const asset = allAssets[i];

      if (i % 10 === 0 || i === totalAssets - 1) {
        send({ type: 'progress', current: i + 1, totalAssets, assetId: asset.id });
      }

      try {
        const results = await qdrantClient.recommend(collection, {
          positive: [asset.id],
          limit: 50,
          score_threshold: scoreThreshold,
          with_payload: false,
        });

        if (results && results.length > 0) {
          for (const r of results) {
            const matchId = Number(r.id);
            const aId = Math.min(asset.id, matchId);
            const bId = Math.max(asset.id, matchId);
            const pairKey = `${aId}-${bId}`;

            // Skip ignored pairs
            if (ignoredSet.has(pairKey)) continue;

            // Union the two assets
            union(asset.id, matchId);

            // Store the best score for this pair
            const score = Math.round(Number(r.score) * 100);
            if (!pairScores.has(pairKey) || pairScores.get(pairKey) < score) {
              pairScores.set(pairKey, score);
            }
          }
        }
      } catch (_) {
        // Asset not in Qdrant yet, skip silently
      }
    }

    send({ type: 'progress', current: totalAssets, totalAssets, phase: 'clustering' });

    // 7. Build clusters from Union-Find
    const clusters = new Map(); // rootId -> [assetId, ...]
    for (const asset of allAssets) {
      if (!parent.has(asset.id)) continue; // never had any match
      const root = find(asset.id);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root).push(asset.id);
    }

    // 8. Build group objects (only clusters with 2+ members)
    const assetMap = new Map(allAssets.map(a => [a.id, a]));

    // We need account info for display
    const clusterIds = [];
    for (const [, members] of clusters) {
      if (members.length > 1) clusterIds.push(...members);
    }
    const uniqueClusterIds = [...new Set(clusterIds)];

    // Batch load accounts
    let accountMap = new Map();
    if (uniqueClusterIds.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < uniqueClusterIds.length; i += chunkSize) {
        const chunk = uniqueClusterIds.slice(i, i + chunkSize);
        const dbAssets = await prisma.asset.findMany({
          where: { id: { in: chunk } },
          select: { id: true, account: { select: { alias: true } } },
        });
        for (const a of dbAssets) accountMap.set(a.id, a.account);
      }
    }

    const groups = [];
    for (const [rootId, members] of clusters) {
      if (members.length < 2) continue;

      // Build items with similarity scores relative to the first member
      const primaryId = members[0]; // highest ID (sorted desc)
      const items = members.map(id => {
        const asset = assetMap.get(id);
        if (!asset) return null;

        let similarity = 100;
        if (id !== primaryId) {
          const aId = Math.min(primaryId, id);
          const bId = Math.max(primaryId, id);
          similarity = pairScores.get(`${aId}-${bId}`) || 0;

          // If no direct pair score, find best score to any member in group
          if (similarity === 0) {
            for (const otherId of members) {
              if (otherId === id) continue;
              const ak = Math.min(otherId, id);
              const bk = Math.max(otherId, id);
              const s = pairScores.get(`${ak}-${bk}`) || 0;
              if (s > similarity) similarity = s;
            }
          }
        }

        return {
          asset: { ...asset, account: accountMap.get(id) || null },
          similarity,
          distance: (similarity / 100).toFixed(4),
        };
      }).filter(Boolean);

      if (items.length > 1) {
        // Sort: highest similarity first (after the primary which is 100%)
        items.sort((a, b) => b.similarity - a.similarity);

        const bestScore = items.filter(i => i.similarity < 100)
          .reduce((max, i) => Math.max(max, i.similarity), 0);

        groups.push({
          id: `group-vis-${rootId}`,
          signature: `visual-${rootId}`,
          confidence: bestScore || threshold,
          items,
        });
      }
    }

    // Sort groups by size descending (biggest duplicates first)
    groups.sort((a, b) => b.items.length - a.items.length);

    send({ type: 'done', totalGroups: groups.length, totalAssets });

    // Send groups in chunks to avoid huge SSE messages
    const CHUNK = 50;
    for (let i = 0; i < groups.length; i += CHUNK) {
      const chunk = groups.slice(i, i + CHUNK);
      send({ type: 'groups', groups: chunk, offset: i });
    }

    send({ type: 'complete' });
    res.end();

  } catch (error) {
    console.error('[AI MULTIMODAL] Full Visual Scan Error:', error);
    send({ type: 'error', message: error.message });
    res.end();
  }
};

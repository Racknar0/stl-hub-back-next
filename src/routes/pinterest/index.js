import express from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import pinterestService from '../../services/pinterest.service.js';
import { dispatchPinterestFailureNotification } from '../../utils/pinterestNotifications.js';
import qdrantMultimodalService from '../../services/qdrantMultimodal.service.js';

const router = express.Router();

function resolveRelativePath(urlOrPath) {
  if (!urlOrPath) return '';
  let clean = String(urlOrPath);
  if (clean.includes('/uploads/')) {
    const parts = clean.split('/uploads/');
    if (parts.length > 1) {
      clean = parts[1];
    }
  }
  return clean.replace(/^\\+|^\/+/, '').replace(/\\/g, '/');
}

// 1. Obtener URL de autorización (Protegido para uso oficial)
router.get('/auth', requireAuth, requireAdmin, (req, res) => {
  try {
    const authUrl = pinterestService.getAuthUrl();
    res.json({ url: authUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TEMPORAL: Ruta pública para que puedas enlazar tu cuenta AHORA MISMO
router.get('/auth-test', (req, res) => {
  try {
    const authUrl = pinterestService.getAuthUrl();
    // Redirige directamente al login de Pinterest
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

// 2. Callback de Pinterest (A donde nos redirige después de dar permisos)
// IMPORTANTE: Esto debe coincidir con PINTEREST_REDIRECT_URI.
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`Error desde Pinterest: ${error}`);
    }

    if (!code) {
      return res.status(400).send('No se proporcionó un código de autorización.');
    }

    // Intercambiar código por tokens
    await pinterestService.exchangeCodeForToken(code);

    // Redirigir de vuelta al dashboard del frontend (puedes ajustar la URL del dashboard)
    res.send(`
      <html>
        <head><title>Pinterest Conectado</title></head>
        <body style="background-color: #09090b; color: #fff; font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h2>¡Pinterest conectado con éxito!</h2>
          <p>Ya puedes cerrar esta ventana y volver al Dashboard.</p>
          <script>
            setTimeout(() => {
              window.close();
            }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error en callback de Pinterest:', error);
    res.status(500).send('Hubo un error al conectar con Pinterest.');
  }
});

// 3. Probar conexión actual
router.get('/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = await pinterestService.testConnection();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Listar tableros reales de Pinterest
router.get('/boards', requireAuth, requireAdmin, async (req, res) => {
  try {
    const boards = await pinterestService.listBoards();
    res.json({ boards });
  } catch (error) {
    console.error('Error fetching boards:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 6. Crear tablero nuevo en Pinterest
router.post('/boards', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'El nombre del tablero es obligatorio.' });
    const board = await pinterestService.createBoard(name, description);
    res.json({ success: true, board });
  } catch (error) {
    console.error('Error creating board:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 7. AI Pinterest SEO Optimizer
import { GoogleGenAI } from '@google/genai';

router.post('/ai-optimize', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, description, tags, category, imageUrl, variationCount = 1, trendKeyword } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const ai = new GoogleGenAI({ apiKey });
    const count = Math.min(Math.max(1, parseInt(variationCount) || 1), 15);

    // Build image part if imageUrl is provided
    const imageParts = [];
    if (imageUrl) {
      try {
        const imgResp = await fetch(imageUrl);
        if (imgResp.ok) {
          const buffer = Buffer.from(await imgResp.arrayBuffer());
          const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
          imageParts.push({ inlineData: { mimeType: contentType, data: buffer.toString('base64') } });
        }
      } catch (e) {
        console.warn('[PINTEREST][AI] Could not fetch image:', e.message);
      }
    }

    let trendInstruction = '';
    if (trendKeyword && String(trendKeyword).trim()) {
      const cleanTrend = String(trendKeyword).trim();
      trendInstruction = [
        '',
        '## CRITICAL PIN REGULATION - PINTEREST TREND MATCHING:',
        `- Pinterest is currently experiencing high search volume for: "${cleanTrend}".`,
        '- You MUST intelligently and creatively adapt the title and description to align this 3D model with this trend keyword, making a logical connection.',
        `- The phrase "${cleanTrend}" MUST appear naturally within the pinTitle and within the pinDescription (without forcing it or looking like spam).`,
        `- Add the hashtag "${cleanTrend.replace(/\s+/g, '')}" as one of the first elements in pinHashtags.`,
        '',
      ].join('\n');
    }

    const prompt = [
      'You are a Pinterest SEO expert for "STL HUB", a store selling 3D printable STL files.',
      `Generate EXACTLY ${count} UNIQUE variation(s). Each MUST have different wording and keyword order.`,
      trendInstruction,
      '',
      '## RULES FOR pinTitle (max 100 chars):',
      '- ALWAYS identify the CHARACTER/SUBJECT name from the title — this is the STAR of the pin',
      '- Pattern: "[Character Name] [Pose/Style] 3D Print STL | [Franchise/Use]"',
      '- Put the recognizable name FIRST — people search by character, not by "3D Print"',
      '- If it\'s from a franchise (Marvel, Anime, DC, etc.), include the franchise name',
      '- NEVER start with "3D Print STL File:" — that\'s boring and wastes title space',
      '- NEVER use "Download Now!" or clickbait CTAs in the title',
      '- Each variation should emphasize a different angle (character, franchise, use case)',
      '',
      'GOOD title examples:',
      '  "Venom Marvel Figure STL File | 3D Printable Collectible"',
      '  "Goku Ultra Instinct 3D Print STL | Dragon Ball Z Figure"',
      '  "Batman Arkham Knight Bust STL | DC Comics 3D Model"',
      '  "Mandalorian Helmet 3D Print File | Star Wars Cosplay STL"',
      '  "Pikachu Planter STL File | Pokémon 3D Print Desk Decor"',
      '',
      'BAD titles (DO NOT generate these):',
      '  "3D Print STL File: Cool Character - Download Now!"',
      '  "Amazing STL Download | 3D Printable Model Free"',
      '  "Best 3D Print Figure STL File For Your Collection"',
      '',
      '## RULES FOR pinDescription (250-400 chars):',
      '- Start with what the model IS, not generic filler',
      '- Write like a collector recommending to a friend, not a robot',
      '- Mention specific details: pose, size potential, print type (resin/FDM)',
      '- Include ONE soft CTA at the end: "Perfect for...", "Add it to your collection"',
      '- NEVER use hashtags in the description',
      '- NEVER repeat the exact title in the description',
      '',
      '## RULES FOR pinHashtags (exactly 20):',
      '- Array of 20 strings WITHOUT # symbol',
      '- NEVER use spaces in hashtags — use CamelCase: "CasualAthlete" NOT "Casual Athlete"',
      '- First 5: ultra-specific (character name, franchise, pose)',
      '- Next 5: niche (AnimeFigure, MarvelCollectible, etc.)',
      '- Next 5: medium (3Dprinting, STLfile, ResinPrint, FDM)',
      '- Last 5: broad (Maker, DIY, Collectible, HomeDecor, GeekGifts)',
      '- Vary slightly between variations',
      '',
      'Respond ONLY with valid JSON:',
      count === 1
        ? '{"pinTitle": "...", "pinDescription": "...", "pinHashtags": ["..."]}'
        : '{"variations": [{"pinTitle": "...", "pinDescription": "...", "pinHashtags": ["..."]}, ...]}',
      '',
      'ASSET DATA:',
      `- Title: ${title}`,
      `- Description: ${description || 'N/A'}`,
      `- Tags: ${Array.isArray(tags) ? tags.join(', ') : 'N/A'}`,
      `- Category: ${category || 'General'}`,
    ].join('\n');

    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [prompt, ...imageParts],
      config: { responseMimeType: 'application/json' },
    });

    const rawText = String(response?.text || '').trim();
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Could not parse AI response');
    }

    // Normalize: always return variations array
    if (count === 1 && !parsed.variations) {
      res.json({
        variations: [{
          pinTitle: parsed.pinTitle || title,
          pinDescription: parsed.pinDescription || description,
          pinHashtags: Array.isArray(parsed.pinHashtags) ? parsed.pinHashtags.slice(0, 20).map(h => h.replace(/\s+/g, '')) : [],
        }]
      });
    } else {
      const vars = (parsed.variations || [parsed]).map(v => ({
        pinTitle: v.pinTitle || title,
        pinDescription: v.pinDescription || description,
        pinHashtags: Array.isArray(v.pinHashtags) ? v.pinHashtags.slice(0, 20).map(h => h.replace(/\s+/g, '')) : [],
      }));
      res.json({ variations: vars });
    }
  } catch (error) {
    console.error('Error AI optimize:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Buscar Assets para Pinterest
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Stats: counts by status
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [published, pending, failed] = await Promise.all([
      prisma.pinterestPinQueue.count({ where: { status: 'PUBLISHED' } }),
      prisma.pinterestPinQueue.count({ where: { status: 'PENDING' } }),
      prisma.pinterestPinQueue.count({ where: { status: 'FAILED' } }),
    ]);
    res.json({ published, pending, failed, total: published + pending + failed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Connection status: check if we have a valid token
router.get('/connection-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const token = await prisma.systemSetting.findUnique({ where: { key: 'PINTEREST_ACCESS_TOKEN' } });
    if (!token?.value) return res.json({ connected: false });

    // Quick validation: call user_account
    const baseUrl = process.env.PINTEREST_API_BASE || 'https://api-sandbox.pinterest.com/v5';
    const resp = await fetch(`${baseUrl}/user_account`, {
      headers: { 'Authorization': `Bearer ${token.value}` }
    });
    if (resp.ok) {
      const user = await resp.json();
      return res.json({ connected: true, username: user.username });
    }
    res.json({ connected: false, reason: 'Token expired' });
  } catch (e) {
    res.json({ connected: false, reason: e.message });
  }
});

// 9. Desconectar Pinterest (Eliminar tokens de la base de datos)
router.post('/disconnect', requireAuth, requireAdmin, async (req, res) => {
  try {
    await prisma.systemSetting.deleteMany({
      where: { key: { in: ['PINTEREST_ACCESS_TOKEN', 'PINTEREST_REFRESH_TOKEN', 'PINTEREST_TOKEN_EXPIRES_AT'] } }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error desconectando Pinterest:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/search-assets', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { q, mode } = req.query; // q = query, mode = 'id' o 'name'
    
    if (!q) return res.status(400).json({ error: 'Query is required' });

    const formatAsset = (asset) => {
      let images = [];
      if (asset.images) {
        if (typeof asset.images === 'string') { try { images = JSON.parse(asset.images); } catch(e){} }
        else if (Array.isArray(asset.images)) { images = asset.images; }
      }
      const categoryName = asset.categories?.length > 0 ? asset.categories[0].name : 'General';
      const tags = (asset.tags || []).map(t => t.nameEn || t.name);
      return {
        id: asset.id, title: asset.title,
        titleEn: asset.titleEn || '', description: asset.description || '',
        descriptionEn: asset.descriptionEn || '', slug: asset.slug,
        category: categoryName, tags, images
      };
    };

    if (mode === 'id') {
      // Support comma-separated IDs: "12878, 15432, 9876"
      const ids = String(q).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length === 0) return res.status(400).json({ error: 'Invalid ID format' });

      const assets = await prisma.asset.findMany({
        where: { id: { in: ids } },
        include: { categories: true, tags: true }
      });

      if (assets.length === 0) return res.json({ found: false });

      res.json({ found: true, assets: assets.map(formatAsset) });
    } else if (mode === 'semantic' || mode === 'ai') {
      try {
        console.log(`[PINTEREST][SEARCH] Buscando semánticamente en Qdrant: "${q}"`);
        const qdrantResults = await qdrantMultimodalService.searchByImage(
          null,
          null,
          q,
          30,
          0.1
        );

        if (!qdrantResults || qdrantResults.length === 0) {
          return res.json({ found: false, assets: [] });
        }

        const ids = qdrantResults.map(r => Number(r.id)).filter(Boolean);
        const assets = await prisma.asset.findMany({
          where: { id: { in: ids }, status: 'PUBLISHED' },
          include: { categories: true, tags: true }
        });

        // Ordenar según relevancia en Qdrant
        const sortedAssets = ids
          .map(id => assets.find(a => a.id === id))
          .filter(Boolean);

        if (sortedAssets.length === 0) return res.json({ found: false, assets: [] });

        res.json({ found: true, assets: sortedAssets.map(formatAsset) });
      } catch (err) {
        console.error('[PINTEREST][SEARCH] Error en búsqueda semántica de Qdrant:', err.message);
        res.status(500).json({ error: 'Error en búsqueda semántica de Qdrant' });
      }
    } else {
      const asset = await prisma.asset.findFirst({
        where: { title: { contains: q } },
        include: { categories: true, tags: true }
      });
      if (!asset) return res.json({ found: false });
      res.json({ found: true, assets: [formatAsset(asset)] });
    }
  } catch (error) {
    console.error('Error searching asset:', error);
    res.status(500).json({ error: 'Error searching asset' });
  }
});

router.post('/schedule', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { 
      assetId, 
      scheduledAt, 
      boardId, 
      title, 
      description, 
      link, 
      filters, 
      images 
    } = req.body;

    if (!assetId || !images || images.length === 0 || !scheduledAt) {
      return res.status(400).json({ error: 'Faltan datos obligatorios para programar (assetId, images, scheduledAt).' });
    }

    // Convertir a Date
    const baseScheduleDate = new Date(scheduledAt);

    const queuedPins = [];
    
    for (let i = 0; i < images.length; i++) {
      const imgUrl = images[i];
      const pinDate = new Date(baseScheduleDate.getTime() + (i * 45 * 60000));
      
      // Copy image to permanent pinterest-pins/ folder
      const UPLOADS_DIR = path.resolve('uploads');
      const PINS_DIR = path.join(UPLOADS_DIR, 'pinterest-pins');
      if (!fs.existsSync(PINS_DIR)) fs.mkdirSync(PINS_DIR, { recursive: true });

      const relativeSrc = resolveRelativePath(imgUrl);
      const srcPath = path.join(UPLOADS_DIR, relativeSrc);
      const ext = path.extname(relativeSrc) || '.webp';
      let permanentRelPath;
      
      // Si ya está guardada en pinterest-pins/ (por ejemplo si ya se recortó y subió), no hace falta copiarla de nuevo
      if (relativeSrc.startsWith('pinterest-pins/')) {
        permanentRelPath = relativeSrc;
      } else {
        const pinFileName = `pin_${assetId}_${Date.now()}_${i}${ext}`;
        const destPath = path.join(PINS_DIR, pinFileName);
        permanentRelPath = `pinterest-pins/${pinFileName}`;
        try {
          if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
          } else {
            console.warn(`[PINTEREST] Archivo de origen no encontrado en disco: ${srcPath}. Se usará la ruta relativa.`);
            permanentRelPath = relativeSrc;
          }
        } catch (e) {
          console.warn('[PINTEREST] Could not copy image:', e.message);
          permanentRelPath = relativeSrc;
        }
      }

      const UPLOADS_BASE = process.env.UPLOADS_BASE_URL || `http://localhost:${process.env.PORT || 3001}/uploads`;
      const fullImageUrl = `${UPLOADS_BASE}/${permanentRelPath}`;

      const newPin = await prisma.pinterestPinQueue.create({
        data: {
          assetId: Number(assetId),
          scheduledAt: pinDate,
          status: 'PENDING',
          boardId: boardId || 'Automático',
          title: title,
          description: description,
          link: link,
          filters: { ...filters, imageUrl: fullImageUrl, imagePath: permanentRelPath }
        }
      });
      queuedPins.push(newPin);
    }

    res.json({ success: true, queued: queuedPins.length, data: queuedPins });
  } catch (error) {
    console.error('Error scheduling Pinterest pins:', error);
    res.status(500).json({ error: 'Ocurrió un error al encolar los pines.' });
  }
});

// 8. Obtener conteo de pines por día para el calendario
router.get('/queue-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month); // 0-indexed from frontend
    if (isNaN(m)) return res.json({ pinsByDay: {} });

    const startDate = new Date(y, m, 1);
    const endDate = new Date(y, m + 1, 1);

    const pins = await prisma.pinterestPinQueue.findMany({
      where: {
        scheduledAt: { gte: startDate, lt: endDate }
      },
      select: { scheduledAt: true, status: true }
    });

    // Agrupar por día
    const pinsByDay = {};
    for (const pin of pins) {
      const day = new Date(pin.scheduledAt).getDate();
      if (!pinsByDay[day]) pinsByDay[day] = { total: 0, pending: 0, published: 0, failed: 0 };
      pinsByDay[day].total++;
      if (pin.status === 'PENDING') pinsByDay[day].pending++;
      else if (pin.status === 'PUBLISHED') pinsByDay[day].published++;
      else if (pin.status === 'FAILED') pinsByDay[day].failed++;
    }

    res.json({ pinsByDay });
  } catch (error) {
    console.error('Error fetching queue stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// 9. Listar pines de un día específico
router.get('/queue-day', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { year, month, day } = req.query;
    const y = parseInt(year), m = parseInt(month), d = parseInt(day);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return res.json({ pins: [] });

    const startDate = new Date(y, m, d);
    const endDate = new Date(y, m, d + 1);

    const pins = await prisma.pinterestPinQueue.findMany({
      where: { scheduledAt: { gte: startDate, lt: endDate } },
      orderBy: { scheduledAt: 'asc' },
    });

    res.json({ pins });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 10. Eliminar un pin de la cola
router.delete('/queue/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    await prisma.pinterestPinQueue.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 11. Actualizar un pin pendiente
router.put('/queue/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const existing = await prisma.pinterestPinQueue.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Pin not found' });
    if (existing.status !== 'PENDING') return res.status(400).json({ error: 'Only PENDING pins can be edited' });

    const { title, description, link, boardId, scheduledAt } = req.body;
    const updated = await prisma.pinterestPinQueue.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(link !== undefined && { link }),
        ...(boardId !== undefined && { boardId }),
        ...(scheduledAt !== undefined && { scheduledAt: new Date(scheduledAt) }),
      }
    });

    res.json({ success: true, pin: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 12. Upload a cropped/edited image
import pinterestPublisherService from '../../services/pinterestPublisher.service.js';

router.post('/upload-cropped', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { base64, assetId } = req.body;
    if (!base64) return res.status(400).json({ error: 'base64 is required' });

    const base64Data = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const UPLOADS_DIR = path.resolve('uploads');
    const PINS_DIR = path.join(UPLOADS_DIR, 'pinterest-pins');
    if (!fs.existsSync(PINS_DIR)) fs.mkdirSync(PINS_DIR, { recursive: true });

    const fileName = `cropped_${assetId || 'pin'}_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(PINS_DIR, fileName), buffer);

    const relPath = `pinterest-pins/${fileName}`;
    const UPLOADS_BASE = process.env.UPLOADS_BASE_URL || `http://localhost:${process.env.PORT || 3001}/uploads`;
    res.json({ success: true, imageUrl: relPath, fullUrl: `${UPLOADS_BASE}/${relPath}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 13. Publicar un pin AHORA (test/inmediato)

router.post('/publish-now', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { assetId, imageUrl, title, description, link, boardId, filters = {} } = req.body;
    if (!imageUrl || !title) return res.status(400).json({ error: 'imageUrl y title son obligatorios' });

    // Copy image to pinterest-pins/
    const UPLOADS_DIR = path.resolve('uploads');
    const PINS_DIR = path.join(UPLOADS_DIR, 'pinterest-pins');
    if (!fs.existsSync(PINS_DIR)) fs.mkdirSync(PINS_DIR, { recursive: true });

    const relativeSrc = resolveRelativePath(imageUrl);
    const srcPath = path.join(UPLOADS_DIR, relativeSrc);
    const ext = path.extname(relativeSrc) || '.webp';
    
    let permanentRelPath;
    if (relativeSrc.startsWith('pinterest-pins/')) {
      permanentRelPath = relativeSrc;
    } else {
      const pinFileName = `pin_${assetId || 'now'}_${Date.now()}${ext}`;
      const destPath = path.join(PINS_DIR, pinFileName);
      permanentRelPath = `pinterest-pins/${pinFileName}`;
      try {
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
        } else {
          permanentRelPath = relativeSrc;
        }
      } catch (e) {
        permanentRelPath = relativeSrc;
      }
    }

    const UPLOADS_BASE = process.env.UPLOADS_BASE_URL || `http://localhost:${process.env.PORT || 3001}/uploads`;
    const fullImageUrl = `${UPLOADS_BASE}/${permanentRelPath}`;

    // Save to DB as PUBLISHING
    const pin = await prisma.pinterestPinQueue.create({
      data: {
        assetId: assetId ? Number(assetId) : 0,
        scheduledAt: new Date(),
        status: 'PENDING',
        boardId: boardId || 'Automático',
        title, description, link,
        filters: { ...filters, imageUrl: fullImageUrl, imagePath: permanentRelPath }
      }
    });

    // Publish immediately
    try {
      const result = await pinterestPublisherService.publishPin(
        fullImageUrl,
        boardId && boardId !== 'auto' && boardId !== 'Automático' ? boardId : null,
        title, description, link, filters,
        assetId ? Number(assetId) : null
      );

      await prisma.pinterestPinQueue.update({
        where: { id: pin.id },
        data: { status: 'PUBLISHED', publishedPinId: result.id }
      });

      res.json({ success: true, pinId: result.id, url: result.url, dbId: pin.id });
    } catch (pubError) {
      await prisma.pinterestPinQueue.update({
        where: { id: pin.id },
        data: { status: 'FAILED', errorMessage: pubError.message }
      });

      // Crear notificación de error interna en la BD y enviar email al administrador
      await dispatchPinterestFailureNotification({
        pinId: pin.id,
        assetId: assetId ? Number(assetId) : 0,
        title: title,
        errorMsg: pubError.message,
        link: link,
        isImmediate: true
      });

      res.status(500).json({ error: pubError.message, dbId: pin.id });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

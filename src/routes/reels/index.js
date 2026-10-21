import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import reels, { PLATFORMS, assetLink, dayKey, defaultPlatforms } from '../../services/reels.service.js';
import youtube from '../../services/youtube.service.js';

const router = express.Router();
const prisma = new PrismaClient();
const REELS_DIR = path.resolve('uploads', 'reels');

const uploadVideos = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(REELS_DIR, { recursive: true });
      cb(null, REELS_DIR);
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
      cb(null, `reel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    if (/^video\/(mp4|quicktime)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error(`"${file.originalname}" no es MP4 ni MOV`));
  },
});

const sendError = (res, error) => res.status(error.status || 500).json({ error: error.message });
const normalizePlatforms = (value) => PLATFORMS.filter(p => (Array.isArray(value) ? value : []).includes(p));
const normalizeHashtags = (value) => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(h => String(h).replace(/[#\s]+/g, '')).filter(Boolean).slice(0, 5);

// El nombre del video empieza por el ID del asset: "11848 sqall ff8.mp4" o "11848.mp4"
const assetIdFromName = (name) => {
  const match = String(name || '').match(/^\s*(\d{1,9})(?!\d)/);
  return match ? parseInt(match[1], 10) : null;
};

// 1. Subir uno o varios videos: cada uno se convierte en un borrador de la bandeja (sin textos todavía)
router.post('/upload', requireAuth, requireAdmin, (req, res) => {
  uploadVideos.array('videos', 20)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files?.length) return res.status(400).json({ error: 'No se recibió ningún video' });
    try {
      // Duración y resolución las lee el navegador y llegan en el mismo orden que los archivos
      let meta = [];
      try { meta = JSON.parse(req.body.meta || '[]'); } catch { /* sin metadatos */ }
      const { language } = await reels.getSettings();
      const platforms = await defaultPlatforms();
      const posts = [];
      for (const [i, file] of req.files.entries()) {
        const m = meta[i] || {};
        // multer entrega el nombre en latin1: se convierte a UTF-8 para conservar tildes y símbolos
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const parsedId = assetIdFromName(originalName);
        const asset = parsedId
          ? await prisma.asset.findUnique({ where: { id: parsedId }, select: { id: true, title: true, titleEn: true, slug: true } })
          : null;
        posts.push(await prisma.reelPost.create({
          data: {
            videoPath: `reels/${file.filename}`,
            originalName,
            ...(asset && { assetId: asset.id, assetTitle: asset.titleEn || asset.title, link: assetLink(asset, language) }),
            fileSizeB: file.size,
            durationSec: Number(m.durationSec) || null,
            width: parseInt(m.width, 10) || null,
            height: parseInt(m.height, 10) || null,
            platforms,
            language,
            aiStatus: 'NONE', // los textos se generan cuando se pulse "Generar metadata IA"
          },
        }));
      }
      res.json({ posts });
    } catch (error) {
      sendError(res, error);
    }
  });
});

// 1b. Generar metadata con IA para los reels que aún no la tienen (o los ids indicados)
router.post('/ai-generate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
    const posts = await prisma.reelPost.findMany({
      where: ids?.length
        ? { id: { in: ids }, status: { not: 'PUBLISHED' }, aiStatus: { not: 'PROCESSING' } }
        : { status: { not: 'PUBLISHED' }, aiStatus: { in: ['NONE', 'ERROR'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!posts.length) return res.json({ queued: 0 });
    // Se marcan como "procesando" ya, para que la interfaz lo muestre sin esperar a la cola
    await prisma.reelPost.updateMany({ where: { id: { in: posts.map(p => p.id) } }, data: { aiStatus: 'PROCESSING', aiError: null } });
    reels.enqueueAi(posts.map(p => p.id));
    res.json({ queued: posts.length });
  } catch (error) { sendError(res, error); }
});

// 2. Bandeja: reels sin día asignado
router.get('/tray', requireAuth, requireAdmin, async (req, res) => {
  try {
    const posts = await prisma.reelPost.findMany({ where: { scheduledAt: null, status: { not: 'PUBLISHED' } }, orderBy: { createdAt: 'asc' } });
    res.json({ posts });
  } catch (error) { sendError(res, error); }
});

// 3. Reels del mes, por día (uno por día)
router.get('/month', requireAuth, requireAdmin, async (req, res) => {
  try {
    const y = parseInt(req.query.year, 10) || new Date().getFullYear();
    const m = parseInt(req.query.month, 10);
    if (isNaN(m)) return res.json({ postsByDay: {} });
    const posts = await prisma.reelPost.findMany({
      where: { scheduledAt: { gte: new Date(y, m, 1), lt: new Date(y, m + 1, 1) } },
      orderBy: { scheduledAt: 'asc' },
    });
    const postsByDay = {};
    for (const post of posts) postsByDay[new Date(post.scheduledAt).getDate()] ??= post;
    res.json({ postsByDay });
  } catch (error) { sendError(res, error); }
});

// 4. Totales
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [published, scheduled, pendingReview, tray, failed, noMetadata] = await Promise.all([
      prisma.reelPost.count({ where: { status: 'PUBLISHED' } }),
      prisma.reelPost.count({ where: { status: 'PENDING', approved: true, scheduledAt: { not: null } } }),
      prisma.reelPost.count({ where: { status: 'PENDING', approved: false, scheduledAt: { not: null } } }),
      prisma.reelPost.count({ where: { scheduledAt: null, status: { not: 'PUBLISHED' } } }),
      prisma.reelPost.count({ where: { status: 'FAILED' } }),
      prisma.reelPost.count({ where: { status: { not: 'PUBLISHED' }, aiStatus: { in: ['NONE', 'ERROR'] } } }),
    ]);
    // Días seguidos cubiertos desde hoy (o mañana si hoy ya se publicó)
    const upcoming = await prisma.reelPost.findMany({ where: { scheduledAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } }, select: { scheduledAt: true } });
    const days = new Set(upcoming.map(p => dayKey(p.scheduledAt)));
    let coveredDays = 0;
    for (let d = new Date(); days.has(dayKey(d)); d.setDate(d.getDate() + 1)) coveredDays++;
    res.json({ published, scheduled, pendingReview, tray, failed, noMetadata, coveredDays });
  } catch (error) { sendError(res, error); }
});

// 5. Ajustes (hora por defecto e idioma)
router.get('/settings', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await reels.getSettings()); } catch (error) { sendError(res, error); }
});
router.put('/settings', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await reels.saveSettings(req.body)); } catch (error) { res.status(400).json({ error: error.message }); }
});

// 6. Estado de las cuentas (por ahora solo comprueba que haya credenciales configuradas)
router.get('/connection-status', requireAuth, requireAdmin, async (req, res) => {
  const meta = !!(process.env.META_SYSTEM_USER_TOKEN && process.env.META_PAGE_ID && process.env.META_IG_USER_ID);
  const yt = await youtube.connectionStatus().catch(() => ({ configured: false, connected: false }));
  res.json({
    instagram: { configured: meta },
    facebook: { configured: meta },
    youtube: { ...yt, appConfigured: youtube.youtubeConfigured() },
  });
});

// 6b. YouTube: URL para autorizar el canal (el frontend la abre en una ventana nueva)
router.get('/youtube/auth', requireAuth, requireAdmin, (req, res) => {
  try { res.json({ url: youtube.getAuthUrl() }); } catch (error) { res.status(400).json({ error: error.message }); }
});

// 6c. YouTube: Google redirige aquí tras autorizar (ruta pública, protegida por el parámetro state)
router.get('/youtube/callback', async (req, res) => {
  const page = (title, text, ok) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
    <body style="background:#09090b;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;">
      <h2 style="color:${ok ? '#22c55e' : '#f87171'}">${title}</h2><p>${text}</p>
      ${ok ? '<script>setTimeout(() => window.close(), 3000)</script>' : ''}
    </body></html>`;
  try {
    if (req.query.error) return res.status(400).send(page('YouTube no se conectó', `Google respondió: ${String(req.query.error).replace(/[<>]/g, '')}`, false));
    const channel = await youtube.handleCallback({ code: req.query.code, state: req.query.state });
    res.send(page('¡YouTube conectado!', `Canal: <b>${String(channel.title || '').replace(/[<>]/g, '')}</b>. Ya puedes cerrar esta ventana y volver al Reels Publisher.`, true));
  } catch (error) {
    console.error('[REELS][YOUTUBE] Callback:', error.message);
    res.status(400).send(page('YouTube no se conectó', String(error.message).replace(/[<>]/g, ''), false));
  }
});

// 6d. YouTube: desconectar el canal
router.post('/youtube/disconnect', requireAuth, requireAdmin, async (req, res) => {
  try { await youtube.disconnect(); res.json({ success: true }); } catch (error) { sendError(res, error); }
});

// 7. Rellenar los próximos días libres con la bandeja
router.post('/auto-fill', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await reels.autoFill()); } catch (error) { sendError(res, error); }
});

// 8. Datos de un asset (para vincularlo a mano)
router.get('/asset/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, title: true, titleEn: true, slug: true } });
    if (!asset) return res.status(404).json({ error: 'Asset no encontrado' });
    res.json({ asset: { ...asset, link: assetLink(asset, req.query.lang) } });
  } catch (error) { sendError(res, error); }
});

// 9. Asignar día ({ day: 'YYYY-MM-DD' } o { day: null } para devolverlo a la bandeja)
router.post('/:id/assign', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ post: await reels.assignDay(parseInt(req.params.id, 10), req.body.day || null) }); }
  catch (error) { sendError(res, error); }
});

// 10. Regenerar textos con IA (opcionalmente con notas, idioma o asset nuevo)
router.post('/:id/ai', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { notes, language, assetId } = req.body;
    if (assetId !== undefined) await prisma.reelPost.update({ where: { id }, data: { assetId: assetId ? parseInt(assetId, 10) : null, assetTitle: null, link: null } });
    const post = await reels.processReelAi(id, { notes, language });
    if (!post) return res.status(404).json({ error: 'Reel no encontrado' });
    if (post.aiStatus === 'ERROR') return res.status(500).json({ error: post.aiError, post });
    res.json({ post });
  } catch (error) { sendError(res, error); }
});

// 11. Editar textos, redes, hora, asset o aprobación
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.reelPost.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Reel no encontrado' });
    if (existing.status === 'PUBLISHED') return res.status(400).json({ error: 'Un reel publicado no se puede editar' });
    if (existing.publishing) return res.status(409).json({ error: 'El reel se está publicando ahora mismo' });

    const b = req.body;
    const text = (v) => (v?.trim() ? v.trim() : null);
    const data = {
      ...(b.caption !== undefined && { caption: text(b.caption) }),
      ...(b.facebookCaption !== undefined && { facebookCaption: text(b.facebookCaption) }),
      ...(b.title !== undefined && { title: text(b.title) }),
      ...(b.youtubeDescription !== undefined && { youtubeDescription: text(b.youtubeDescription) }),
      ...(b.onScreenText !== undefined && { onScreenText: text(b.onScreenText)?.slice(0, 120) ?? null }),
      ...(b.hashtags !== undefined && { hashtags: normalizeHashtags(b.hashtags) }),
    };
    if (b.platforms !== undefined) {
      const targets = normalizePlatforms(b.platforms);
      if (!targets.length) return res.status(400).json({ error: 'Elige al menos una red' });
      data.platforms = targets;
    }
    if (b.time !== undefined) {
      if (!existing.scheduledAt) return res.status(400).json({ error: 'Asigna primero un día' });
      if (!/^\d{2}:\d{2}$/.test(b.time)) return res.status(400).json({ error: 'Hora inválida' });
      const [hh, mm] = b.time.split(':').map(Number);
      const d = new Date(existing.scheduledAt);
      d.setHours(hh, mm, 0, 0);
      data.scheduledAt = d;
    }
    if (b.assetId !== undefined) {
      const asset = b.assetId ? await prisma.asset.findUnique({ where: { id: parseInt(b.assetId, 10) } }) : null;
      if (b.assetId && !asset) return res.status(404).json({ error: 'Asset no encontrado' });
      Object.assign(data, { assetId: asset?.id ?? null, assetTitle: asset ? (asset.titleEn || asset.title) : null, link: assetLink(asset, existing.language) });
    }
    if (b.approved !== undefined) {
      if (b.approved) {
        const missing = reels.missingFields({ ...existing, ...data });
        if (missing.length) return res.status(400).json({ error: `Antes de aprobar falta: ${missing.join(', ')}` });
      }
      data.approved = !!b.approved;
      if (existing.status === 'FAILED') Object.assign(data, { status: 'PENDING', errorMessage: null });
    }
    const post = await prisma.reelPost.update({ where: { id }, data });
    res.json({ post });
  } catch (error) { sendError(res, error); }
});

// 12. Publicar ahora (también sirve para reintentar un reel con error)
router.post('/:id/publish', requireAuth, requireAdmin, async (req, res) => {
  try {
    const post = await prisma.reelPost.findUnique({ where: { id: parseInt(req.params.id, 10) } });
    if (!post) return res.status(404).json({ error: 'Reel no encontrado' });
    if (post.status === 'PUBLISHED') return res.status(400).json({ error: 'Este reel ya está publicado' });
    if (post.publishing) return res.status(409).json({ error: 'Este reel ya se está publicando' });
    const missing = reels.missingFields(post);
    if (missing.length) return res.status(400).json({ error: `Falta: ${missing.join(', ')}` });

    // Publicar ahora ocupa el día de hoy: si hoy tenía otro reel sin publicar, vuelve a la bandeja
    const now = new Date();
    await prisma.reelPost.updateMany({
      where: { id: { not: post.id }, status: { not: 'PUBLISHED' }, publishing: false, scheduledAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()), lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) } },
      data: { scheduledAt: null },
    });
    const dated = await prisma.reelPost.update({ where: { id: post.id }, data: { scheduledAt: now, approved: true } });

    const { publishMode } = await reels.getSettings();
    if (publishMode !== 'real') return res.json({ post: await reels.publishReel(dated), mode: publishMode });

    // En real la subida tarda (Instagram procesa el video): se lanza en segundo plano y la interfaz consulta el estado
    await prisma.reelPost.update({ where: { id: post.id }, data: { publishing: true, errorMessage: null } });
    reels.publishInBackground({ ...dated, publishing: true });
    res.json({ post: { ...dated, publishing: true }, mode: publishMode });
  } catch (error) { sendError(res, error); }
});

// 13. Eliminar (borra también el video)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await reels.deleteReel(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (error) { sendError(res, error); }
});

export default router;

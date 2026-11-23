import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import horizontalService from '../../services/horizontalShowcase.service.js';

const router = express.Router();

// 1. Estado general, KPIs, canales y próxima recopilación
router.get('/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await horizontalService.getHorizontalStatus();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 1b. Hora diaria (Colombia) del video automático
router.put('/daily-time', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cfg = await horizontalService.setAutoDailyTime(req.body?.time);
    res.json({ success: true, time: cfg.time });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 2. Modelos con su estado de rotación / cooldown
router.get('/models', requireAuth, requireAdmin, async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const models = await horizontalService.getHorizontalModels(filter);
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Historial de recopilaciones publicadas
router.get('/history', requireAuth, requireAdmin, async (req, res) => {
  try {
    const history = await horizontalService.getHorizontalHistory();
    res.json({ history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Regenerar metadata con IA (Gemini) respetando los capítulos
router.post('/regenerate-metadata', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { heroId, channelName, language } = req.body || {};
    const metadata = await horizontalService.generateAiMetadata({ heroId, channelName, language });
    res.json({ success: true, ...metadata });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Generación / Ensamble de una recopilación
router.post('/generate', requireAuth, requireAdmin, async (req, res) => {
  if (req.setTimeout) req.setTimeout(600000); // 10 minutos para FFmpeg
  try {
    const { heroId, channelName, title, description, tags, language, render } = req.body || {};
    const result = await horizontalService.createCompilation({
      heroId,
      channelName,
      title,
      description,
      tags,
      language,
      render: render !== false
    });
    res.json({ success: true, compilation: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Publicación inmediata a YouTube
router.post('/publish', requireAuth, requireAdmin, async (req, res) => {
  if (req.setTimeout) req.setTimeout(600000); // la subida (o el render si no hay video) puede tardar minutos
  try {
    const { compilationId } = req.body || {};
    // Sin id: publica la última recopilación ya generada; solo si no hay ninguna, genera una nueva
    let id = compilationId || (await horizontalService.latestReadyCompilation())?.id;
    if (!id) {
      const created = await horizontalService.createCompilation({ render: true });
      id = created.id;
    }
    const result = await horizontalService.publishToYouTube(id);
    res.json({ success: true, published: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7. Publicación en Facebook (Página en turno): la subida sigue en segundo plano y el panel consulta /status
router.post('/publish-facebook', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.body?.compilationId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Falta la recopilación a publicar' });
    const result = await horizontalService.publishToFacebook(id, { background: true });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;

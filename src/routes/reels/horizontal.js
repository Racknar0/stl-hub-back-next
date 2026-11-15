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

// 4. Generación / Ensamble de una recopilación
router.post('/generate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { heroId, channelName, title, description, render } = req.body || {};
    const result = await horizontalService.createCompilation({
      heroId,
      channelName,
      title,
      description,
      render: !!render
    });
    res.json({ success: true, compilation: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Publicación inmediata a YouTube
router.post('/publish', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { compilationId } = req.body || {};
    let id = compilationId;
    if (!id) {
      // Si no viene id, crea una y publícala
      const created = await horizontalService.createCompilation({ render: false });
      id = created.id;
    }
    const result = await horizontalService.publishToYouTube(id);
    res.json({ success: true, published: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Sincronización a Facebook
router.post('/:id/sync-facebook', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Marca como sincronizado o llama a la API de Facebook
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const updated = await prisma.horizontalCompilation.update({
      where: { id: Number(id) },
      data: { fbSynced: true }
    });
    res.json({ success: true, compilation: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

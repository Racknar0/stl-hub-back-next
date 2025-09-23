import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { listUserDownloads } from '../../controllers/downloadHistory.controller.js';

const router = Router();

// GET /downloads/history - historial del usuario autenticado
router.get('/history', requireAuth, listUserDownloads);

export default router;

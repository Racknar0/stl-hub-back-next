import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { listShortLinksController, createShortLinksController } from '../../controllers/shortLinks.controller.js';

const router = express.Router();

// Panel: enlaces cortos con sus clics (solo administradores)
router.get('/', requireAuth, requireAdmin, listShortLinksController);
// Crear enlaces cortos a mano (p. ej. los de TikTok, que se programan en TikTok Studio)
router.post('/', requireAuth, requireAdmin, createShortLinksController);

export default router;

import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { listShortLinksController } from '../../controllers/shortLinks.controller.js';

const router = express.Router();

// Panel: enlaces cortos con sus clics (solo administradores)
router.get('/', requireAuth, requireAdmin, listShortLinksController);

export default router;

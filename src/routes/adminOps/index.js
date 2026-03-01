import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { restartBackend } from '../../controllers/adminOps.controller.js';

const router = Router();

router.use(requireAuth, requireAdmin);

// POST /api/admin/ops/restart
router.post('/restart', restartBackend);

export default router;

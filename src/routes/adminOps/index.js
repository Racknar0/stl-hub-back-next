import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { restartBackend, testEmail } from '../../controllers/adminOps.controller.js';

const router = Router();

router.use(requireAuth, requireAdmin);

// POST /api/admin/ops/restart
router.post('/restart', restartBackend);

// POST /api/admin/ops/test-email
router.post('/test-email', testEmail);

export default router;

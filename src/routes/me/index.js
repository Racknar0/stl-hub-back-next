import { Router } from 'express';
import { requireAuth } from '../../middlewares/auth.js';
import { getMyProfile, getMyDownloads, getMyStats } from '../../controllers/me.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/profile', getMyProfile);
router.get('/downloads', getMyDownloads);
router.get('/stats', getMyStats);

export default router;

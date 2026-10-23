import express from 'express';
import downloaderRoutes from './downloader.routes.js';
import organizerRoutes from './organizer.routes.js';
import { requireAuthOrQueryToken, requireAdmin } from '../../middlewares/auth.js';

const router = express.Router();

// Este router se monta en '/', así que la auth va por subruta (no con router.use global)
router.use('/telegram', requireAuthOrQueryToken, requireAdmin, downloaderRoutes);
router.use('/organizer', requireAuthOrQueryToken, requireAdmin, organizerRoutes);

export default router;

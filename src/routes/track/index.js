import { Router } from 'express';
import { recordCampaignVisit } from '../../controllers/metrics.controller.js';

const router = Router();

// Tracking público de campañas (sin auth)
router.post('/campaign-visit', recordCampaignVisit);

export default router;

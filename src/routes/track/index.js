import { Router } from 'express';
import { recordCampaignVisit, recordSiteVisit } from '../../controllers/metrics.controller.js';

const router = Router();

// Tracking público de campañas (sin auth)
router.post('/campaign-visit', recordCampaignVisit);
router.post('/site-visit', recordSiteVisit);


export default router;

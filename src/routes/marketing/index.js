import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  createMarketingCampaign,
  listMarketingCampaigns,
  updateMarketingCampaign,
} from '../../controllers/marketing.controller.js';

const router = Router();

router.use(requireAuth, requireAdmin);
router.get('/campaigns', listMarketingCampaigns);
router.post('/campaigns', createMarketingCampaign);
router.put('/campaigns/:id', updateMarketingCampaign);

export default router;

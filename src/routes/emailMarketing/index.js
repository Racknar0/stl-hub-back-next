import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  getEngine,
  updateEngine,
  sendEngineTest,
  getReengage,
  launchReengage,
  getOverview,
  getAudiences,
  listAudience,
  getFlows,
  listTemplates,
  listLogs,
  listSends,
  syncStages,
  optOutContact,
  optInContact,
  listCampaigns,
  previewCampaignAudience,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  launchCampaign,
  cancelCampaign,
  testCampaign,
} from '../../controllers/emailMarketing.controller.js';

const router = Router();

// Todo el módulo es de admin.
router.use(requireAuth, requireAdmin);

router.get('/overview', getOverview);
router.get('/flows', getFlows);
router.get('/templates', listTemplates);
router.get('/logs', listLogs);
router.get('/sends', listSends);
router.get('/engine', getEngine);
router.put('/engine', updateEngine);
router.post('/engine/test', sendEngineTest);
router.get('/reengage', getReengage);
router.post('/reengage/launch', launchReengage);

router.get('/campaigns', listCampaigns);
router.get('/campaigns/audience', previewCampaignAudience);
router.post('/campaigns', createCampaign);
router.put('/campaigns/:id', updateCampaign);
router.delete('/campaigns/:id', deleteCampaign);
router.post('/campaigns/:id/launch', launchCampaign);
router.post('/campaigns/:id/cancel', cancelCampaign);
router.post('/campaigns/:id/test', testCampaign);

router.get('/audiences', getAudiences);
router.get('/audiences/:stage', listAudience);

router.post('/sync', syncStages);
router.post('/contacts/:userId/opt-out', optOutContact);
router.post('/contacts/:userId/opt-in', optInContact);

export default router;

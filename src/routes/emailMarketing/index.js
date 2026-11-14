import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  getEngine,
  updateEngine,
  getOverview,
  getAudiences,
  listAudience,
  getFlows,
  listTemplates,
  listLogs,
  syncStages,
  optOutContact,
  optInContact,
} from '../../controllers/emailMarketing.controller.js';

const router = Router();

// Todo el módulo es de admin.
router.use(requireAuth, requireAdmin);

router.get('/overview', getOverview);
router.get('/flows', getFlows);
router.get('/templates', listTemplates);
router.get('/logs', listLogs);
router.get('/engine', getEngine);
router.put('/engine', updateEngine);

router.get('/audiences', getAudiences);
router.get('/audiences/:stage', listAudience);

router.post('/sync', syncStages);
router.post('/contacts/:userId/opt-out', optOutContact);
router.post('/contacts/:userId/opt-in', optInContact);

export default router;

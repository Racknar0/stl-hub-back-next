import express from 'express';
import { getVectorSyncStatus, syncMissingVectors } from '../controllers/ai.controller.js';
import { getMultimodalVectorSyncStatus, syncMissingMultimodalVectors } from '../controllers/aiMultimodal.controller.js';

const router = express.Router();

router.get('/sync-status', getVectorSyncStatus);
router.post('/sync-missing', syncMissingVectors);

router.get('/sync-multimodal-status', getMultimodalVectorSyncStatus);
router.post('/sync-multimodal-missing', syncMissingMultimodalVectors);

export default router;

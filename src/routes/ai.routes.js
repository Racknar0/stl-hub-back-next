import express from 'express';
import { getVectorSyncStatus, syncMissingVectors } from '../controllers/ai.controller.js';

const router = express.Router();

router.get('/sync-status', getVectorSyncStatus);
router.post('/sync-missing', syncMissingVectors);

export default router;

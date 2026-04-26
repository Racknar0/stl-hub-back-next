import express from 'express';
import multer from 'multer';
import { getVectorSyncStatus, syncMissingVectors } from '../controllers/ai.controller.js';
import { getMultimodalVectorSyncStatus, syncMissingMultimodalVectors, searchByImageHandler, searchByLocalImageHandler, getVisualSimilarGroupsBatch, fullVisualSimilarScan } from '../controllers/aiMultimodal.controller.js';

const router = express.Router();
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/sync-status', getVectorSyncStatus);
router.post('/sync-missing', syncMissingVectors);

router.get('/sync-multimodal-status', getMultimodalVectorSyncStatus);
router.post('/sync-multimodal-missing', syncMissingMultimodalVectors);

router.post('/search-by-image', uploadMemory.single('image'), searchByImageHandler);
router.post('/search-by-local-image', searchByLocalImageHandler);
router.get('/similar-visual-batch', getVisualSimilarGroupsBatch);
router.get('/similar-visual-full-scan', fullVisualSimilarScan);

export default router;

import express from 'express';
import multer from 'multer';
import { getVectorSyncStatus, syncMissingVectors } from '../../controllers/ai.controller.js';
import { getMultimodalVectorSyncStatus, syncMissingMultimodalVectors, searchByImageHandler, searchByLocalImageHandler, getVisualSimilarGroupsBatch } from '../../controllers/aiMultimodal.controller.js';
import { optionalAuth } from '../../middlewares/nsfwFilter.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';

const router = express.Router();
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/sync-status', requireAuth, requireAdmin, getVectorSyncStatus);
router.post('/sync-missing', requireAuth, requireAdmin, syncMissingVectors);

router.get('/sync-multimodal-status', requireAuth, requireAdmin, getMultimodalVectorSyncStatus);
router.post('/sync-multimodal-missing', requireAuth, requireAdmin, syncMissingMultimodalVectors);

router.post('/search-by-image', optionalAuth, uploadMemory.single('image'), searchByImageHandler);
router.post('/search-by-local-image', optionalAuth, searchByLocalImageHandler);
router.get('/similar-visual-batch', requireAuth, requireAdmin, getVisualSimilarGroupsBatch);

export default router;

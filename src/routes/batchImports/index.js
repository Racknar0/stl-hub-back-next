import express from 'express';
import { scanLocalDirectory, getScanStatus, getBatchQueue, retryBatchAiFailedItems, updateBatchItem, confirmBatchItems, stopAndResetBatchToDraft, deleteBatchItem, purgeAll, purgeCompleted, retryBatchItemWithAnotherProxy } from '../../controllers/batchImport.controller.js';
import { requireAuth } from '../../middlewares/auth.js';

const router = express.Router();

router.post('/scan', requireAuth, scanLocalDirectory);
router.get('/scan-status', requireAuth, getScanStatus);
router.post('/retry-ai', requireAuth, retryBatchAiFailedItems);
router.post('/ai-metadata', requireAuth, retryBatchAiFailedItems);
router.get('/', requireAuth, getBatchQueue);
router.patch('/items/:id', requireAuth, updateBatchItem);
router.post('/confirm', requireAuth, confirmBatchItems);
router.post('/stop-and-draft', requireAuth, stopAndResetBatchToDraft);
router.post('/items/:id/retry-proxy', requireAuth, retryBatchItemWithAnotherProxy);
router.delete('/items/:id', requireAuth, deleteBatchItem);
router.delete('/completed', requireAuth, purgeCompleted);
router.delete('/purge-all', requireAuth, purgeAll);

export default router;

import express from 'express';
import { scanLocalDirectory, getBatchQueue, updateBatchItem, confirmBatchItems, deleteBatchItem, purgeAll, purgeCompleted, retryBatchItemWithAnotherProxy } from '../../controllers/batchImport.controller.js';
import { requireAuth } from '../../middlewares/auth.js';

const router = express.Router();

router.post('/scan', requireAuth, scanLocalDirectory);
router.get('/', requireAuth, getBatchQueue);
router.patch('/items/:id', requireAuth, updateBatchItem);
router.post('/confirm', requireAuth, confirmBatchItems);
router.post('/items/:id/retry-proxy', requireAuth, retryBatchItemWithAnotherProxy);
router.delete('/items/:id', requireAuth, deleteBatchItem);
router.delete('/completed', requireAuth, purgeCompleted);
router.delete('/purge-all', requireAuth, purgeAll);

export default router;

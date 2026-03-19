import express from 'express';
import { scanLocalDirectory, getBatchQueue, updateBatchItem, confirmBatchItems, deleteBatchItem, purgeAll } from '../../controllers/batchImport.controller.js';
import { requireAuth } from '../../middlewares/auth.js';

const router = express.Router();

router.post('/scan', requireAuth, scanLocalDirectory);
router.get('/', requireAuth, getBatchQueue);
router.patch('/items/:id', requireAuth, updateBatchItem);
router.post('/confirm', requireAuth, confirmBatchItems);
router.delete('/items/:id', requireAuth, deleteBatchItem);
router.delete('/purge-all', requireAuth, purgeAll);

export default router;

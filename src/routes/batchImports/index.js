import express from 'express';
import fs from 'fs';
import path from 'path';
import { 
  scanLocalDirectory, 
  getScanStatus, 
  getBatchQueue, 
  retryBatchAiFailedItems, 
  updateBatchItem, 
  updateBatchItemsBulk, 
  confirmBatchItems, 
  stopAndResetBatchToDraft, 
  deleteBatchItem, 
  purgeAll, 
  purgeCompleted, 
  retryBatchItemWithAnotherProxy,
  precalculateBatchSimilars,
  stopPrecalculateBatchSimilars,
  getPrecalculateSimilarsStatus,
  getAiMetadataStatus
} from '../../controllers/batchImport.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';

const router = express.Router();

router.post('/scan', requireAuth, requireAdmin, scanLocalDirectory);
router.get('/scan-status', requireAuth, requireAdmin, getScanStatus);
router.post('/retry-ai', requireAuth, requireAdmin, retryBatchAiFailedItems);
router.post('/ai-metadata', requireAuth, requireAdmin, retryBatchAiFailedItems);
router.get('/ai-metadata/status', requireAuth, requireAdmin, getAiMetadataStatus);
router.post('/precalculate-similars', requireAuth, requireAdmin, precalculateBatchSimilars);
router.post('/precalculate-similars/stop', requireAuth, requireAdmin, stopPrecalculateBatchSimilars);
router.get('/precalculate-similars/status', requireAuth, requireAdmin, getPrecalculateSimilarsStatus);
router.get('/', requireAuth, requireAdmin, getBatchQueue);
router.post('/items-bulk', requireAuth, requireAdmin, updateBatchItemsBulk);
router.patch('/items/:id', requireAuth, requireAdmin, updateBatchItem);
router.post('/confirm', requireAuth, requireAdmin, confirmBatchItems);
router.post('/stop-and-draft', requireAuth, requireAdmin, stopAndResetBatchToDraft);
router.post('/items/:id/retry-proxy', requireAuth, requireAdmin, retryBatchItemWithAnotherProxy);
router.delete('/items/:id', requireAuth, requireAdmin, deleteBatchItem);
router.delete('/completed', requireAuth, requireAdmin, purgeCompleted);
router.delete('/purge-all', requireAuth, requireAdmin, purgeAll);

// Purge telegram_downloads_organized folder
router.delete('/purge-organized', requireAuth, requireAdmin, async (req, res) => {
  const organizedDir = path.join(process.cwd(), 'uploads', 'telegram_downloads_organized');
  try {
    if (!fs.existsSync(organizedDir)) {
      return res.json({ success: true, message: 'La carpeta organized ya estaba vacía.', deleted: 0 });
    }
    const entries = fs.readdirSync(organizedDir);
    let deleted = 0;
    for (const entry of entries) {
      const entryPath = path.join(organizedDir, entry);
      fs.rmSync(entryPath, { recursive: true, force: true });
      deleted++;
    }
    res.json({ success: true, message: `Carpeta organized purgada: ${deleted} elementos eliminados.`, deleted });
  } catch (error) {
    console.error('Error purging organized directory:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;

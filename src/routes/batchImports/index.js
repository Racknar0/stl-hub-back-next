import express from 'express';
import fs from 'fs';
import path from 'path';
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

// Purge telegram_downloads_organized folder
router.delete('/purge-organized', requireAuth, async (req, res) => {
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

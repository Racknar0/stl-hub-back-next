import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  getAsset,
  getAssetBySlug,
  listPublishedSlugs,
  listAssets,
  uploadImages,
  updateAsset,
  deleteAsset,
  latestAssets,
  searchAssets,
  requestDownload,
  mostDownloadedAssets,
  getMegaMenuData,
  randomizeFree,
  listAssetReplicas,
  restoreAssetFromBackup,
  checkAssetUnique,
  getStagedStatusBatch,
  getBatchImportsStagedStatus,
  getScpConfig,
  getScpCommand,
  saveSelectedAssetMeta,
  generateAssetMetaDescriptions,
  generateAssetMetaTags,
  listIgnoredSimilarPairs,
  upsertIgnoredSimilarPairs,
  clearIgnoredSimilarPairs,
  deleteIgnoredSimilarPair,
} from '../../controllers/asset.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'
import { createBrokenReport } from '../../controllers/brokenReport.controller.js'

const router = Router();

// Directorios base
const UPLOADS_DIR = path.resolve('uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');

// Asegurar carpetas
for (const d of [UPLOADS_DIR, TEMP_DIR, IMAGES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const tsName = (original) => {
  const ext = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 80);
  return `${Date.now()}_${base}${ext}`;
};

// Multer para imágenes a tmp
const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => cb(null, tsName(file.originalname)),
});
const uploadImagesMulter = multer({ storage: imageStorage });

// Rutas públicas
router.get('/latest', latestAssets);
router.get('/top', mostDownloadedAssets);
router.get('/menu/mega', getMegaMenuData);
router.get('/search', searchAssets);
router.get('/slugs', listPublishedSlugs);
router.get('/slug/:slug', getAssetBySlug);
router.get('/:id(\\d+)', getAsset);
router.post('/:id/request-download', requestDownload);
router.post('/:id/report-broken-link', createBrokenReport);

// Réplicas (público para UI de progreso)
router.get('/:id/replicas', listAssetReplicas);
// Staged status para batch imports
router.get('/staged-status/batch', getStagedStatusBatch);
router.post('/staged-status/batch', getStagedStatusBatch);
router.get('/staged-status/batch-imports', getBatchImportsStagedStatus);
router.post('/staged-status/batch-imports', getBatchImportsStagedStatus);

//! A partir de aquí, requieren admin
router.use(requireAuth, requireAdmin)

// Randomizar freebies
router.post('/randomize-free', randomizeFree)

// Pares de similares ignorados (usado por VisualSimilarTab)
router.get('/similar/ignored-pairs', listIgnoredSimilarPairs);
router.post('/similar/ignored-pairs', upsertIgnoredSimilarPairs);
router.delete('/similar/ignored-pairs', clearIgnoredSimilarPairs);
router.delete('/similar/ignored-pairs/:assetAId/:assetBId', deleteIgnoredSimilarPair);

// Assets CRUD
router.get('/', listAssets);
router.get('/check-unique', checkAssetUnique);
// SCP (usado por batch upload)
router.get('/scp-config', getScpConfig);
router.post('/scp-command', getScpCommand);
// Meta AI
router.post('/meta/save-selected', saveSelectedAssetMeta);
router.post('/meta/generate-descriptions', generateAssetMetaDescriptions);
router.post('/meta/generate-tags', generateAssetMetaTags);
router.put('/:id', updateAsset);
router.delete('/:id', deleteAsset);

// Imágenes (usado en edición de assets)
router.post('/:assetId/images', uploadImagesMulter.array('images', 20), uploadImages);

router.post('/:assetId/restore-link', restoreAssetFromBackup);

export default router;

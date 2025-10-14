import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  createAsset,
  createAssetFull,
  enqueueUploadToMega,
  getAsset,
  getAssetProgress,
  getAssetBySlug,
  listPublishedSlugs,
  listAssets,
  uploadImages,
  uploadArchiveTemp,
  updateAsset,
  deleteAsset,
  latestAssets,
  searchAssets,
  requestDownload,
  mostDownloadedAssets,
  randomizeFree,
  listAssetReplicas,
  getFullProgress,
  restoreAssetFromBackup,
  checkAssetUnique,
  testUploadSpeed,
  getStagedStatus,
  getScpConfig,
  getUploadsRoot,
} from '../../controllers/asset.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'
import { createBrokenReport } from '../../controllers/brokenReport.controller.js'

const router = Router();

// Directorios base
const UPLOADS_DIR = path.resolve('uploads');
const TEMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const ARCHIVES_DIR = path.join(UPLOADS_DIR, 'archives');

// Asegurar carpetas
for (const d of [UPLOADS_DIR, TEMP_DIR, IMAGES_DIR, ARCHIVES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const tsName = (original) => {
  const ext = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 80);
  return `${Date.now()}_${base}${ext}`;
};

// Multer para archivo principal (asset) a tmp
const archiveStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => cb(null, tsName(file.originalname)),
});
const uploadArchive = multer({ storage: archiveStorage });

// Multer para imágenes (legacy: directo a images). Para flujo unificado, usamos tmp.
const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => cb(null, tsName(file.originalname)),
});
const uploadImagesMulter = multer({ storage: imageStorage });

// Multer combinado para /upload (todo va a tmp)
const uploadCombined = multer({ storage: archiveStorage });

// Rutas públicas
router.get('/latest', latestAssets);
router.get('/top', mostDownloadedAssets);
router.get('/search', searchAssets);
router.get('/slugs', listPublishedSlugs);
// Nueva ruta por slug (antes de :id para evitar conflicto con texto que sea numérico)
router.get('/slug/:slug', getAssetBySlug);
router.get('/:id(\\d+)', getAsset);
router.post('/:id/request-download', requestDownload);
// Reportar link roto (público: no requiere login)
router.post('/:id/report-broken-link', createBrokenReport);

// IMPORTANTE: Endpoints de progreso deben ser públicos para no desconectar al usuario por expiración del token
router.get('/:id/progress', getAssetProgress);
router.get('/:id/replicas', listAssetReplicas);
router.get('/:id/full-progress', getFullProgress);
// Estado de archivo staged en uploads/tmp (para flujo SCP) también sin auth
router.get('/staged-status', getStagedStatus);

//! A partir de aquí, requieren admin
router.use(requireAuth, requireAdmin)

// Nuevo: randomizar freebies
router.post('/randomize-free', randomizeFree)

// GET /assets?q=texto&pageIndex=0&pageSize=25 para paginación del lado del servidor
router.get('/', listAssets);
// Validación pre-flight de unicidad de slug/carpeta
router.get('/check-unique', checkAssetUnique);
// Nuevo: configuración SCP del servidor (seguro, sin password)
router.get('/scp-config', getScpConfig);
router.get('/uploads-root', getUploadsRoot);
router.put('/:id', updateAsset);
router.delete('/:id', deleteAsset);

// Flujo unificado: archivo + imágenes en una sola llamada
router.post('/upload', uploadCombined.fields([
  { name: 'archive', maxCount: 1 },
  { name: 'images', maxCount: 20 },
]), createAssetFull);

// Rutas legacy (si se desea usar por pasos)
router.post('/upload-archive', uploadArchive.single('archive'), uploadArchiveTemp);
router.post('/:assetId/images', uploadImagesMulter.array('images', 20), uploadImages);
router.post('/', createAsset);

// Encolar manualmente (si no se usó flujo unificado)
router.post('/:id/enqueue', enqueueUploadToMega);

// Test endpoint para medir velocidad pura de upload
router.post('/test-upload-speed', testUploadSpeed);

router.post('/:assetId/restore-link', restoreAssetFromBackup); // alias


export default router;

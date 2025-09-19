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
  listAssets,
  uploadImages,
  uploadArchiveTemp,
  updateAsset
} from '../../controllers/asset.controller.js';

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

// Rutas
// GET /assets?q=texto&pageIndex=0&pageSize=25 para paginación del lado del servidor
router.get('/', listAssets);
router.get('/:id', getAsset);
router.get('/:id/progress', getAssetProgress);
router.put('/:id', updateAsset);

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

export default router;

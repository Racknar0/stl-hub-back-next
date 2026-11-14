import express from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { HERO_SLOTS, HERO_MAX_FILE_BYTES } from '../../services/heroBanners.service.js';
import { createHeroRenderHandler, listPublicHeroBanners, listAdminHeroBanners, createHeroBanner, updateHeroBanner, archiveHeroBanner, sendHeroError } from '../../controllers/heroBanners.controller.js';

export const publicHeroBannersRouter = express.Router();
publicHeroBannersRouter.get('/', listPublicHeroBanners);
publicHeroBannersRouter.get('/render/:lang/:device', createHeroRenderHandler());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: HERO_MAX_FILE_BYTES, files: 4, fields: 8, fieldSize: 2048, parts: 12 } });
const uploadComponents = upload.fields(HERO_SLOTS.map(name => ({ name, maxCount: 1 })));
const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);
adminRouter.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
adminRouter.get('/', listAdminHeroBanners);
adminRouter.post('/', (req, res, next) => {
  uploadComponents(req, res, error => {
    if (!error) return next();
    error.status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    error.message = error.code === 'LIMIT_FILE_SIZE' ? 'Cada imagen debe pesar como máximo 10 MB.' : 'Sube exactamente las cuatro imágenes requeridas, una por componente.';
    return sendHeroError(res, error);
  });
}, createHeroBanner);
adminRouter.patch('/:id', updateHeroBanner);
adminRouter.delete('/:id', archiveHeroBanner);
export default adminRouter;

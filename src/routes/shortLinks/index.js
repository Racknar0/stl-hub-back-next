import express from 'express';
import { resolveShortLinkController } from '../../controllers/shortLinks.controller.js';

const router = express.Router();

// Público: resuelve un enlace corto (stlgratis.com/v/<code>) y cuenta el clic
router.get('/:code', resolveShortLinkController);

export default router;

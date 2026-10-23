import express from 'express';
import { getNote, saveNote } from '../../controllers/notes.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/', getNote);
router.put('/', saveNote);

export default router;

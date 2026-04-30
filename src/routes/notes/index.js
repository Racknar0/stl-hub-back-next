import express from 'express';
import { getNote, saveNote } from '../../controllers/notes.controller.js';

const router = express.Router();

router.get('/', getNote);
router.put('/', saveNote);

export default router;

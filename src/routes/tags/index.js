import { Router } from 'express';
import { listTags, getTag, createTag, updateTag, deleteTag } from '../../controllers/tag.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'
import { optionalAuth } from '../../middlewares/nsfwFilter.js'

const router = Router();

// públicas (si quieres listar tags en público)
router.get('/', optionalAuth, listTags);
router.get('/:id', getTag);

// admin
router.use(requireAuth, requireAdmin)
router.post('/', createTag);
router.put('/:id', updateTag);
router.delete('/:id', deleteTag);

export default router;

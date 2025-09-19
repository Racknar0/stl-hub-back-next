import { Router } from 'express';
import { listTags, getTag, createTag, updateTag, deleteTag } from '../../controllers/tag.controller.js';

const router = Router();

router.get('/', listTags);
router.get('/:id', getTag);
router.post('/', createTag);
router.put('/:id', updateTag);
router.delete('/:id', deleteTag);

export default router;

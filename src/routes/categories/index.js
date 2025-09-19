import { Router } from 'express';
import { listCategories, getCategory, createCategory, updateCategory, deleteCategory } from '../../controllers/category.controller.js';

const router = Router();

router.get('/', listCategories);
router.get('/:id', getCategory);
router.post('/', createCategory);
router.put('/:id', updateCategory);
router.delete('/:id', deleteCategory);

export default router;

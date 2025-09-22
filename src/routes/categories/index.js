import { Router } from 'express';
import { listCategories, getCategory, createCategory, updateCategory, deleteCategory } from '../../controllers/category.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'

const router = Router();

// públicas (si quieres mostrar categorías en público)
router.get('/', listCategories);
router.get('/:id', getCategory);

// admin
router.use(requireAuth, requireAdmin)
router.post('/', createCategory);
router.put('/:id', updateCategory);
router.delete('/:id', deleteCategory);

export default router;

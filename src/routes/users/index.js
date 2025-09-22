import { Router } from 'express';
import { createUser, deleteUser, getUserById, getUsers, updateUser, extendSubscription } from '../../controllers/user.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'

const router = Router();

router.use(requireAuth, requireAdmin)

router.get('/', getUsers);
router.get('/:id', getUserById);
router.post('/', createUser);
router.put('/:id', updateUser);
router.post('/:id/subscription/extend', extendSubscription);
router.delete('/:id', deleteUser);

export default router;
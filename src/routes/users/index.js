import { Router } from 'express';
import { createUser, deleteUser, getUserById, getUsers, updateUser, extendSubscription, resetUserFreebieRolls } from '../../controllers/user.controller.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js'

const router = Router();

router.use(requireAuth, requireAdmin)

router.get('/', getUsers);
router.get('/:id', getUserById);
router.post('/', createUser);
router.put('/:id', updateUser);
router.post('/:id/subscription/extend', extendSubscription);
router.post('/:id/freebie-rolls/reset', resetUserFreebieRolls);
router.delete('/:id', deleteUser);

export default router;
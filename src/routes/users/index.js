import { Router } from 'express';
import { createUser, deleteUser, getUserById, getUsers } from '../../controllers/user.controller.js';

const router = Router();

router.get('/', getUsers);
router.get('/:id', getUserById);
router.post('/', createUser);
router.delete('/:id', deleteUser);

export default router;
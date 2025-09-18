import express from 'express';
import authRoutes from './auth/index.js';
import userRoutes from './users/index.js';
import accountRoutes from './accounts/index.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/accounts', accountRoutes);

export default router;
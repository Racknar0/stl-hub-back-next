import express from 'express';
import authRoutes from './auth/index.js';
import userRoutes from './users/index.js';
import accountRoutes from './accounts/index.js';
import assetRoutes from './assets/index.js';
import categoryRoutes from './categories/index.js';
import tagRoutes from './tags/index.js';
import reportsRoutes from './reports/index.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/accounts', accountRoutes);
router.use('/assets', assetRoutes);
router.use('/categories', categoryRoutes);
router.use('/tags', tagRoutes);
router.use('/admin/reports', reportsRoutes);

export default router;
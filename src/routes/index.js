import express from 'express';
import authRoutes from './auth/index.js';
import userRoutes from './users/index.js';
import accountRoutes from './accounts/index.js';
import assetRoutes from './assets/index.js';
import categoryRoutes from './categories/index.js';
import tagRoutes from './tags/index.js';
import reportsRoutes from './reports/index.js';
import downloadsRoutes from './downloads/index.js';
import meRoutes from './me/index.js';
import notificationsRoutes from './notifications/index.js';
import paymentsRoutes from './payments/index.js';
import metricsRoutes from './metrics/index.js';
import adminOpsRoutes from './adminOps/index.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/accounts', accountRoutes);
router.use('/assets', assetRoutes);
router.use('/categories', categoryRoutes);
router.use('/tags', tagRoutes);

router.use('/payments', paymentsRoutes);

router.use('/admin/reports', reportsRoutes);
router.use('/admin/notifications', notificationsRoutes);
router.use('/admin/ops', adminOpsRoutes);

router.use('/downloads', downloadsRoutes);
router.use('/me', meRoutes);
router.use('/metrics', metricsRoutes);

export default router;
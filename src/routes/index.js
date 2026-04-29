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
import trackRoutes from './track/index.js';
import adminOpsRoutes from './adminOps/index.js';
import marketingRoutes from './marketing/index.js';
import batchImportsRoutes from './batchImports/index.js';
import aiRoutes from './ai/index.js';
import telegramRoutes from './telegram/index.js';
import fileExplorerRoutes from './fileExplorer/fileExplorer.routes.js';

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
router.use('/admin/marketing', marketingRoutes);

router.use('/downloads', downloadsRoutes);
router.use('/me', meRoutes);
router.use('/metrics', metricsRoutes);
router.use('/track', trackRoutes);
router.use('/batch-imports', batchImportsRoutes);

router.use('/ai', aiRoutes);
router.use('/file-explorer', fileExplorerRoutes);
router.use('/', telegramRoutes);

export default router;
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
import settingsRoutes from './settings/index.js';
import notesRoutes from './notes/index.js';

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
router.use('/admin/settings', settingsRoutes);
router.use('/admin/notes', notesRoutes);

router.use('/downloads', downloadsRoutes);
router.use('/me', meRoutes);
router.use('/metrics', metricsRoutes);
router.use('/track', trackRoutes);
router.use('/batch-imports', batchImportsRoutes);

router.use('/ai', aiRoutes);
router.use('/file-explorer', fileExplorerRoutes);
router.use('/', telegramRoutes);

// Public promo status (no auth)
router.get('/promo/status', async (req, res) => {
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const active = await prisma.systemSetting.findUnique({ where: { key: 'LAUNCH_PROMO_ACTIVE' } });
    const isActive = active?.value === 'true';

    if (!isActive) return res.json({ active: false });

    const daysSetting = await prisma.systemSetting.findUnique({ where: { key: 'LAUNCH_PROMO_DAYS' } });
    const startSetting = await prisma.systemSetting.findUnique({ where: { key: 'LAUNCH_PROMO_START' } });
    const days = Number(daysSetting?.value || 0);
    const start = startSetting?.value ? new Date(startSetting.value) : null;

    if (days > 0 && start && !Number.isNaN(start.getTime())) {
      const elapsed = (Date.now() - start.getTime()) / (24 * 60 * 60 * 1000);
      if (elapsed > days) return res.json({ active: false });
      return res.json({ active: true, daysLeft: Math.ceil(days - elapsed) });
    }

    return res.json({ active: true, daysLeft: null }); // unlimited
  } catch (e) {
    console.error('promo/status error', e);
    return res.json({ active: false });
  }
});

export default router;
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
import emailMarketingRoutes from './emailMarketing/index.js';
import { handleBrevoWebhook } from '../controllers/brevoWebhook.controller.js';
import { unsubscribePage, unsubscribeOneClick } from '../controllers/emailUnsubscribe.controller.js';
import batchImportsRoutes from './batchImports/index.js';
import aiRoutes from './ai/index.js';
import telegramRoutes from './telegram/index.js';
import fileExplorerRoutes from './fileExplorer/fileExplorer.routes.js';
import settingsRoutes from './settings/index.js';
import notesRoutes from './notes/index.js';
import pinterestRoutes from './pinterest/index.js';
import reelsRoutes from './reels/index.js';
import shortLinksRoutes from './shortLinks/index.js';
import adminShortLinksRoutes from './shortLinks/admin.js';
import heroBannersRoutes, { publicHeroBannersRouter } from './heroBanners/index.js';
import adminLicensesRoutes, { publicLicensesRouter } from './licenses/index.js';
import reviewsRoutes, { adminReviewsRouter } from './reviews/index.js';
import { requireAuth, requireAdmin, requireAuthOrQueryToken } from '../middlewares/auth.js';
import {
  createGiftCode, listGiftCodes, updateGiftCode, deleteGiftCode,
  validateGiftCode, redeemGiftCode,
} from '../controllers/giftCode.controller.js';

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
// Email marketing (embudos, audiencias, plantillas). Namespace aparte
// para no mezclarlo con las campañas UTM de /admin/marketing.
router.use('/admin/email-marketing', emailMarketingRoutes);
router.use('/admin/settings', settingsRoutes);
router.use('/admin/notes', notesRoutes);
router.use('/admin/hero-banners', heroBannersRoutes);
router.use('/hero-banners', publicHeroBannersRouter);

router.use('/downloads', downloadsRoutes);
router.use('/me', meRoutes);
router.use('/metrics', metricsRoutes);
router.use('/track', trackRoutes);
router.use('/batch-imports', batchImportsRoutes);

router.use('/ai', aiRoutes);
router.use('/file-explorer', requireAuthOrQueryToken, requireAdmin, fileExplorerRoutes);
router.use('/pinterest', pinterestRoutes);
// Enlaces cortos propios: /api/s/<code> (público, lo usa la ruta /v/<code> del front)
router.use('/s', shortLinksRoutes);
router.use('/admin/short-links', adminShortLinksRoutes);
router.use('/reels', reelsRoutes);
// Servidor de licencias de programas de escritorio: público para los programas, admin para el dashboard
router.use('/v1/licenses', publicLicensesRouter);
router.use('/admin/licenses', adminLicensesRoutes);
// Opiniones sobre la web: público/usuario en /reviews, moderación en /admin/reviews
router.use('/reviews', reviewsRoutes);
router.use('/admin/reviews', adminReviewsRouter);
router.use('/', telegramRoutes);

// ─── Gift Codes ────────────────────────────────────────
router.post('/admin/gift-codes', requireAuth, requireAdmin, createGiftCode);
router.get('/admin/gift-codes', requireAuth, requireAdmin, listGiftCodes);
router.patch('/admin/gift-codes/:id', requireAuth, requireAdmin, updateGiftCode);
router.delete('/admin/gift-codes/:id', requireAuth, requireAdmin, deleteGiftCode);
router.get('/gift-codes/validate', validateGiftCode);          // public - for registration form
router.post('/gift-codes/redeem', requireAuth, redeemGiftCode); // auth - for logged-in users

// ─── Webhook de Brevo (público, protegido por secreto en la URL) ──────
router.post('/webhooks/brevo', handleBrevoWebhook);

// ─── Baja de correos (público, token firmado) ──────
router.get('/email/unsubscribe/:token', unsubscribePage);
router.post('/email/unsubscribe/:token', unsubscribeOneClick);

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

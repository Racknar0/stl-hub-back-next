import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  getMyReviewPrompt,
  createMyReview,
  listPublicReviews,
  adminListReviews,
  adminUpdateReview,
  adminDeleteReview,
} from '../../controllers/siteReviews.controller.js';

// Opiniones sobre la web: /reviews (público y usuario logueado)
const router = Router();

router.get('/public', listPublicReviews);
router.get('/me/prompt', requireAuth, getMyReviewPrompt);
router.post('/', requireAuth, createMyReview);

// Moderación: /admin/reviews (solo admin)
export const adminReviewsRouter = Router();
adminReviewsRouter.use(requireAuth, requireAdmin);
adminReviewsRouter.get('/', adminListReviews);
adminReviewsRouter.patch('/:id', adminUpdateReview);
adminReviewsRouter.delete('/:id', adminDeleteReview);

export default router;

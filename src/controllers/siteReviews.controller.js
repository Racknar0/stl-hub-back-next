import { PrismaClient } from '@prisma/client';
import {
  parseReviewInput,
  parseAdminReviewUpdate,
  shouldPromptReview,
  publicReviewWhere,
  REVIEW_STATUSES,
} from '../services/siteReviews.service.js';

const prisma = new PrismaClient();

// GET /reviews/me/prompt — ¿se le muestra el modal de opinión al usuario?
export const getMyReviewPrompt = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const [downloads, review] = await Promise.all([
      prisma.downloadHistory.count({ where: { userId } }),
      prisma.siteReview.findUnique({ where: { userId }, select: { id: true } }),
    ]);

    const hasReview = Boolean(review);
    return res.json({ show: shouldPromptReview({ downloads, hasReview }), downloads, hasReview });
  } catch (e) {
    console.error('[REVIEWS] getMyReviewPrompt error:', e?.message || e);
    return res.status(500).json({ message: 'Error checking review prompt' });
  }
};

// POST /reviews — el usuario envía su opinión (queda pendiente de aprobación)
export const createMyReview = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { data, error } = parseReviewInput(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const existing = await prisma.siteReview.findUnique({ where: { userId }, select: { id: true } });
    if (existing) return res.status(409).json({ ok: false, error: 'ALREADY_REVIEWED' });

    const downloads = await prisma.downloadHistory.count({ where: { userId } });
    const created = await prisma.siteReview.create({
      data: { ...data, userId, downloads },
      select: { id: true, status: true, createdAt: true },
    });
    return res.status(201).json({ ok: true, review: created });
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ ok: false, error: 'ALREADY_REVIEWED' });
    console.error('[REVIEWS] createMyReview error:', e?.message || e);
    return res.status(500).json({ message: 'Error saving review' });
  }
};

// GET /reviews/public — opiniones aprobadas para "Lo que dicen los makers"
export const listPublicReviews = async (req, res) => {
  try {
    const take = Math.min(Math.max(parseInt(req.query.take) || 20, 1), 50);
    const items = await prisma.siteReview.findMany({
      where: publicReviewWhere,
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
      take,
      select: { id: true, rating: true, text: true, displayName: true, language: true, downloads: true, createdAt: true },
    });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ items });
  } catch (e) {
    console.error('[REVIEWS] listPublicReviews error:', e?.message || e);
    return res.status(500).json({ message: 'Error listing reviews' });
  }
};

// GET /admin/reviews?status= — moderación (admin)
export const adminListReviews = async (req, res) => {
  try {
    const status = REVIEW_STATUSES.includes(req.query.status) ? req.query.status : 'PENDING';
    const countsOnly = req.query.countsOnly === '1'; // el menú del dashboard solo necesita los contadores
    const [items, grouped] = await Promise.all([
      countsOnly ? [] : prisma.siteReview.findMany({
        where: { status },
        orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
        take: 500,
        include: { user: { select: { email: true, registerCountry: true } } },
      }),
      prisma.siteReview.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0]));
    for (const g of grouped) counts[g.status] = g._count._all;
    return res.json({ items, counts });
  } catch (e) {
    console.error('[REVIEWS] adminListReviews error:', e?.message || e);
    return res.status(500).json({ message: 'Error listing reviews' });
  }
};

// PATCH /admin/reviews/:id — aprobar, rechazar, destacar o corregir erratas
export const adminUpdateReview = async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'INVALID_ID' });

    const { data, error } = parseAdminReviewUpdate(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const updated = await prisma.siteReview.update({ where: { id }, data });
    return res.json({ ok: true, review: updated });
  } catch (e) {
    if (e?.code === 'P2025') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    console.error('[REVIEWS] adminUpdateReview error:', e?.message || e);
    return res.status(500).json({ message: 'Error updating review' });
  }
};

// DELETE /admin/reviews/:id — borrar (el usuario podrá volver a opinar)
export const adminDeleteReview = async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'INVALID_ID' });
    await prisma.siteReview.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (e) {
    if (e?.code === 'P2025') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    console.error('[REVIEWS] adminDeleteReview error:', e?.message || e);
    return res.status(500).json({ message: 'Error deleting review' });
  }
};

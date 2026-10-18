import { PrismaClient } from '@prisma/client';
import {
  PAYMENT_USER_TRACKING_SELECT,
  resolvePaymentAttribution,
} from '../utils/paymentAttribution.js';
import {
  addAttemptEvent,
  createPaymentAttempt,
  effectiveAttemptStatus,
  findOwnedAttempt,
  updateAttempt,
} from '../utils/paymentAttempts.js';

const prisma = new PrismaClient();

const PROVIDERS = new Set(['PAYPAL', 'MERCADOPAGO']);
const MAX_CLIENT_EVENTS_PER_ATTEMPT = 60;

// Eventos que el navegador puede reportar y el estado al que (como mucho) llevan el intento.
const CLIENT_EVENTS = {
  modal_closed: 'CANCELLED',
  checkout_redirect: 'REDIRECTED',
  paypal_button_clicked: 'REDIRECTED',
  paypal_approved: null,
  paypal_cancelled: 'CANCELLED',
  paypal_error: 'ERROR',
  returned: 'RETURNED',
};

const sanitizeData = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 20)) {
    if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[String(k).slice(0, 40)] = typeof v === 'string' ? v.slice(0, 300) : v;
    }
  }
  return out;
};

// POST /api/payments/attempts — el usuario eligió un método de pago.
export async function startPaymentAttempt(req, res) {
  try {
    const userId = Number(req.user?.id) || null;
    const provider = String(req.body?.provider || '').trim().toUpperCase();
    const planId = String(req.body?.planId || '').trim().slice(0, 10);

    if (!userId || !PROVIDERS.has(provider) || !planId) {
      return res.status(200).json({ ok: false, error: 'invalid' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: PAYMENT_USER_TRACKING_SELECT });
    const attribution = user ? await resolvePaymentAttribution({ prismaLike: prisma, req, user }) : null;

    const attempt = await createPaymentAttempt(prisma, { req, userId, provider, planId, attribution });
    if (!attempt) return res.status(200).json({ ok: false });

    await addAttemptEvent(prisma, attempt.id, { type: 'method_selected', source: 'client', status: 'STARTED', detail: provider });
    return res.status(201).json({ ok: true, attemptId: attempt.id });
  } catch (e) {
    console.error('startPaymentAttempt error', e);
    return res.status(200).json({ ok: false });
  }
}

// POST /api/payments/attempts/:id/events — pasos que solo ve el navegador.
export async function recordPaymentAttemptEvent(req, res) {
  try {
    const userId = Number(req.user?.id) || null;
    const type = String(req.body?.type || '').trim();
    if (!Object.prototype.hasOwnProperty.call(CLIENT_EVENTS, type)) {
      return res.status(200).json({ ok: false, error: 'invalid-type' });
    }

    if (!userId) return res.status(200).json({ ok: false, error: 'no-session' });
    const attempt = await findOwnedAttempt(prisma, { attemptId: req.params.id, userId });
    if (!attempt || Number(attempt.userId) !== userId) return res.status(200).json({ ok: false, error: 'not-found' });

    const count = await prisma.paymentAttemptEvent.count({ where: { attemptId: attempt.id, source: 'client' } });
    if (count >= MAX_CLIENT_EVENTS_PER_ATTEMPT) return res.status(200).json({ ok: true, ignored: true });

    const detail = req.body?.detail != null ? String(req.body.detail).slice(0, 255) : null;
    const data = sanitizeData(req.body?.data);
    const nextStatus = CLIENT_EVENTS[type];

    await addAttemptEvent(prisma, attempt.id, { type, source: 'client', status: nextStatus, detail, data });

    const fields = {};
    if (type === 'returned' && !attempt.returnedAt) fields.returnedAt = new Date();
    if (type === 'paypal_error' && detail) fields.lastError = detail;
    await updateAttempt(prisma, attempt, { status: nextStatus, ...fields });

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('recordPaymentAttemptEvent error', e);
    return res.status(200).json({ ok: false });
  }
}

// GET /api/payments/attempts — listado para administración (solo admin).
export async function listPaymentAttempts(req, res) {
  try {
    const now = new Date();
    const fromRaw = String(req.query.from || '').trim();
    const toRaw = String(req.query.to || '').trim();
    const toDate = toRaw ? new Date(`${toRaw}T23:59:59`) : now;
    const fromDate = fromRaw ? new Date(`${fromRaw}T00:00:00`) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ error: 'invalid-dates' });
    }

    const provider = String(req.query.provider || '').trim().toUpperCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

    const attempts = await prisma.paymentAttempt.findMany({
      where: {
        createdAt: { gte: fromDate, lte: toDate },
        ...(PROVIDERS.has(provider) ? { provider } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

    const userIds = [...new Set(attempts.map((a) => a.userId).filter(Boolean))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));

    const summary = {};
    const items = attempts.map((a) => {
      const effectiveStatus = effectiveAttemptStatus(a, now);
      summary[effectiveStatus] = (summary[effectiveStatus] || 0) + 1;
      return { ...a, email: emailById.get(a.userId) || null, effectiveStatus };
    });

    return res.json({
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      total: items.length,
      summary,
      items,
    });
  } catch (e) {
    console.error('listPaymentAttempts error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

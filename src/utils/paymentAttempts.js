// Seguimiento de intentos de pago (PayPal / MercadoPago).
// Todas las funciones son "best effort": nunca deben romper el flujo de cobro,
// por eso capturan sus propios errores y solo los registran en consola.

const FINAL_LOCKED = new Set(['APPROVED', 'REFUNDED', 'CHARGED_BACK', 'DISPUTED']);

// Orden de avance de un intento. Un evento del navegador solo puede mover el estado hacia adelante.
const STATUS_RANK = {
  STARTED: 0,
  CHECKOUT_CREATED: 1,
  REDIRECTED: 2,
  RETURNED: 3,
  CANCELLED: 4,
  ERROR: 4,
  REJECTED: 5,
  PENDING: 6,
  APPROVED: 9,
  DISPUTED: 10,
  REFUNDED: 10,
  CHARGED_BACK: 10,
};

const cut = (value, max) => {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
};

const detectDeviceType = (userAgentRaw) => {
  const ua = String(userAgentRaw || '').toLowerCase();
  if (!ua) return null;
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/mobi|android|iphone/.test(ua)) return 'mobile';
  return 'desktop';
};

export const mapMercadoPagoStatusToAttempt = (statusRaw) => {
  const status = String(statusRaw || '').toLowerCase();
  if (status === 'approved') return 'APPROVED';
  if (['pending', 'in_process', 'authorized'].includes(status)) return 'PENDING';
  if (status === 'rejected') return 'REJECTED';
  if (status === 'cancelled') return 'CANCELLED';
  if (status === 'refunded') return 'REFUNDED';
  if (status === 'charged_back') return 'CHARGED_BACK';
  if (status === 'in_mediation') return 'DISPUTED';
  return 'PENDING';
};

export const createPaymentAttempt = async (prisma, { req, userId, provider, planId, attribution, anonId, sessionId }) => {
  try {
    const userAgent = req?.headers?.['user-agent'] || null;
    const tracking = attribution?.trackingForDb || {};
    const attempt = await prisma.paymentAttempt.create({
      data: {
        userId: userId || null,
        provider,
        planId: cut(planId, 10),
        status: 'STARTED',
        marketingCampaignId: attribution?.marketingCampaignId || null,
        utmSource: cut(tracking.utmSource, 120),
        utmMedium: cut(tracking.utmMedium, 120),
        utmCampaign: cut(tracking.utmCampaign, 160),
        anonId: cut(anonId || req?.body?.anonId, 64),
        sessionId: cut(sessionId || req?.body?.sessionId, 64),
        deviceType: detectDeviceType(userAgent),
        userAgent: cut(userAgent, 255),
      },
    });
    return attempt;
  } catch (e) {
    console.error('[paymentAttempts] create error:', e.message);
    return null;
  }
};

// Devuelve el intento si existe y pertenece al usuario/proveedor indicado.
export const findOwnedAttempt = async (prisma, { attemptId, userId, provider }) => {
  const id = Number(attemptId);
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: Math.trunc(id) } });
    if (!attempt) return null;
    if (userId && attempt.userId && Number(attempt.userId) !== Number(userId)) return null;
    if (provider && attempt.provider !== provider) return null;
    return attempt;
  } catch (e) {
    console.error('[paymentAttempts] find error:', e.message);
    return null;
  }
};

export const findAttemptBy = async (prisma, where) => {
  try {
    return await prisma.paymentAttempt.findFirst({ where, orderBy: { id: 'desc' } });
  } catch (e) {
    console.error('[paymentAttempts] findBy error:', e.message);
    return null;
  }
};

// Agrega un evento a la línea de tiempo. Con `dedupe`, no repite el mismo type+source+status.
export const addAttemptEvent = async (prisma, attemptId, { type, source, status = null, detail = null, data = null, dedupe = false }) => {
  if (!attemptId) return null;
  try {
    if (dedupe) {
      const existing = await prisma.paymentAttemptEvent.findFirst({
        where: { attemptId, type, source, status: status || null },
        select: { id: true },
      });
      if (existing) return existing;
    }
    return await prisma.paymentAttemptEvent.create({
      data: {
        attemptId,
        type: cut(type, 40),
        source: cut(source, 20),
        status: cut(status, 40),
        detail: cut(detail, 255),
        data: data ?? undefined,
      },
    });
  } catch (e) {
    console.error('[paymentAttempts] event error:', e.message);
    return null;
  }
};

// Actualiza el intento. `status` se aplica según quién lo dice:
// - fromProvider=true: es la verdad de la pasarela, se aplica salvo que ya esté aprobado
//   (un aprobado solo puede pasar a devuelto/contracargo/disputa).
// - fromProvider=false: evento nuestro o del navegador, solo avanza en el orden de STATUS_RANK.
export const updateAttempt = async (prisma, attempt, { status, fromProvider = false, ...fields }) => {
  if (!attempt?.id) return null;
  try {
    const data = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) data[k] = v;
    }
    if (data.statusDetail !== undefined) data.statusDetail = cut(data.statusDetail, 120);
    if (data.paymentMethod !== undefined) data.paymentMethod = cut(data.paymentMethod, 80);
    if (data.externalCheckoutId !== undefined) data.externalCheckoutId = cut(data.externalCheckoutId, 120);
    if (data.externalPaymentId !== undefined) data.externalPaymentId = cut(data.externalPaymentId, 120);

    if (status) {
      const current = attempt.status || 'STARTED';
      let apply;
      if (fromProvider) {
        apply = current !== 'APPROVED' || FINAL_LOCKED.has(status);
      } else {
        apply = !FINAL_LOCKED.has(current) && (STATUS_RANK[status] ?? 0) > (STATUS_RANK[current] ?? 0);
      }
      if (apply) {
        data.status = status;
      } else if (fromProvider) {
        // Aviso viejo/de otro pago (ej. un rechazo previo que llega después del aprobado):
        // queda en la línea de tiempo, pero no pisa los datos del pago bueno.
        for (const k of ['statusDetail', 'paymentMethod', 'externalPaymentId', 'paymentId', 'paidAt', 'amount', 'currency']) {
          delete data[k];
        }
      }
    }

    if (!Object.keys(data).length) return attempt;
    return await prisma.paymentAttempt.update({ where: { id: attempt.id }, data });
  } catch (e) {
    console.error('[paymentAttempts] update error:', e.message);
    return attempt;
  }
};

export const createWebhookLog = async (prisma, { provider, topic, externalId, payload }) => {
  try {
    return await prisma.paymentWebhookLog.create({
      data: {
        provider,
        topic: cut(topic, 80),
        externalId: cut(externalId, 120),
        payload: payload ?? undefined,
      },
    });
  } catch (e) {
    console.error('[paymentAttempts] webhook log error:', e.message);
    return null;
  }
};

export const finishWebhookLog = async (prisma, log, { processed, httpStatus, error = null, attemptId = null }) => {
  if (!log?.id) return;
  try {
    await prisma.paymentWebhookLog.update({
      where: { id: log.id },
      data: { processed: Boolean(processed), httpStatus, error: error ? String(error) : null, attemptId },
    });
  } catch (e) {
    console.error('[paymentAttempts] webhook log update error:', e.message);
  }
};

// Un intento sin cerrar por más de este tiempo se considera abandonado.
export const ABANDON_AFTER_MINUTES = 60;
const OPEN_STATUSES = new Set(['STARTED', 'CHECKOUT_CREATED', 'REDIRECTED', 'RETURNED', 'CANCELLED']);

// Estado "efectivo" para reportes: agrega ABANDONED sin tocar la fila.
export const effectiveAttemptStatus = (attempt, now = new Date()) => {
  const status = attempt?.status || 'STARTED';
  if (!OPEN_STATUSES.has(status)) return status;
  const ageMin = (now.getTime() - new Date(attempt.createdAt).getTime()) / 60000;
  return ageMin >= ABANDON_AFTER_MINUTES ? 'ABANDONED' : status;
};

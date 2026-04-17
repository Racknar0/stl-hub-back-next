import plans from '../config/plans.js';
import { PrismaClient } from '@prisma/client';
import {
  extractGatewayTrackingFromMetadata,
  PAYMENT_USER_TRACKING_SELECT,
  resolvePaymentAttribution,
} from '../utils/paymentAttribution.js';
import {
  appendCopSnapshotToRawResponse,
  buildCopSnapshot,
} from '../utils/paymentCurrency.js';

const prisma = new PrismaClient();

// Base oficial de la API REST de MercadoPago.
const MP_API_BASE = 'https://api.mercadopago.com';

// ---------- Helpers de normalizacion/validacion ----------

const parsePositiveInt = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
};

const ensureNoTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const firstHeaderValue = (value) => String(value || '').split(',')[0].trim();

const parseUrlSafe = (value) => {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
};

const isLocalHostname = (hostnameRaw) => {
  const hostname = String(hostnameRaw || '').toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  );
};

const shouldSendAutoReturn = (callbackUrl) => {
  const u = parseUrlSafe(callbackUrl);
  if (!u) return false;
  if (u.protocol !== 'https:') return false;
  if (isLocalHostname(u.hostname)) return false;
  return true;
};

// Lee el token privado desde variables de entorno.
const getAccessToken = () => {
  const token = String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  return token || null;
};

// Decodifica el external_reference para recuperar userId/planId en callbacks/webhooks.
const parseExternalReference = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return { userId: null, planId: null };

  let match = raw.match(/^uid:(\d+)\|plan:([a-z0-9]+)$/i);
  if (match) {
    return {
      userId: parsePositiveInt(match[1]),
      planId: String(match[2] || '').trim() || null,
    };
  }

  match = raw.match(/^user-(\d+)_plan-([a-z0-9]+)$/i);
  if (match) {
    return {
      userId: parsePositiveInt(match[1]),
      planId: String(match[2] || '').trim() || null,
    };
  }

  return { userId: null, planId: null };
};

const mapMpStatusToInternal = (statusRaw) => {
  const status = String(statusRaw || '').toLowerCase();
  if (status === 'approved') return 'COMPLETED';
  if (['pending', 'in_process', 'in_mediation', 'authorized'].includes(status)) return 'PENDING';
  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(status)) return 'FAILED';
  return 'PENDING';
};

// Wrapper HTTP para MercadoPago: centraliza auth, parse JSON y manejo de errores.
const mpRequest = async (path, { method = 'GET', body, accessToken, headers = {} } = {}) => {
  const response = await fetch(`${MP_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`MercadoPago API error (${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
};

const computeNewExpiryDate = (currentPeriodEnd, durationDays) => {
  const now = new Date();
  const startDate = currentPeriodEnd && currentPeriodEnd > now ? currentPeriodEnd : now;
  const newExpiryDate = new Date(startDate);
  newExpiryDate.setDate(newExpiryDate.getDate() + durationDays);
  return newExpiryDate;
};

// Activa/extiende suscripcion solo cuando corresponde (evita duplicar extensiones).
const applySubscriptionIfNeeded = async (userId, selectedPlan, shouldActivate) => {
  if (!shouldActivate) return false;

  const userSubscription = await prisma.subscription.findFirst({
    where: { userId },
  });

  const newExpiryDate = computeNewExpiryDate(userSubscription?.currentPeriodEnd, selectedPlan.durationDays);

  await prisma.subscription.upsert({
    where: { id: userSubscription?.id || 0 },
    update: {
      currentPeriodEnd: newExpiryDate,
      status: 'ACTIVE',
    },
    create: {
      userId,
      currentPeriodEnd: newExpiryDate,
      status: 'ACTIVE',
    },
  });

  return true;
};

// Determina URL de webhook: usa env explicita o la infiere del host/proxy actual.
const getWebhookUrl = (req) => {
  const explicit = String(process.env.MERCADOPAGO_WEBHOOK_URL || '').trim();
  if (explicit) return explicit;

  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
  const host = forwardedHost || req.get('host') || 'localhost:3001';
  const proto = forwardedProto || req.protocol || 'http';
  const apiBase = ensureNoTrailingSlash(`${proto}://${host}`);
  return `${apiBase}/api/payments/mercadopago/webhook`;
};

// Procesador comun para pagos ya emitidos por MercadoPago (callback y webhook).
// 1) Resuelve user/plan
// 2) Resuelve atribucion de campaña
// 3) Crea/actualiza Payment de forma idempotente
// 4) Activa suscripcion si status aprobado
const processMercadoPagoPayment = async ({ paymentData, req }) => {
  const externalOrderId = String(paymentData?.id || '').trim();
  if (!externalOrderId) {
    return { ok: false, statusCode: 400, message: 'paymentId inválido en respuesta de MercadoPago' };
  }

  const mappedStatus = mapMpStatusToInternal(paymentData?.status);
  const parsedReference = parseExternalReference(paymentData?.external_reference);

  const metadataUserId = parsePositiveInt(paymentData?.metadata?.userId);
  const metadataPlanId = String(paymentData?.metadata?.planId || '').trim() || null;

  const userId = parsedReference.userId || metadataUserId;
  const planId = parsedReference.planId || metadataPlanId;

  if (!userId || !planId) {
    return {
      ok: false,
      statusCode: 400,
      message: 'No se pudo resolver userId/planId desde external_reference del pago',
    };
  }

  const selectedPlan = plans[planId];
  if (!selectedPlan) {
    return { ok: false, statusCode: 404, message: `Plan '${planId}' no encontrado` };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PAYMENT_USER_TRACKING_SELECT,
  });

  if (!user) {
    return { ok: false, statusCode: 404, message: `Usuario ${userId} no encontrado` };
  }

  const gatewayTracking = extractGatewayTrackingFromMetadata(paymentData?.metadata);
  const attribution = await resolvePaymentAttribution({
    prismaLike: prisma,
    req,
    user,
    gatewayTracking,
  });

  const paymentAmount = Number(paymentData?.transaction_amount || selectedPlan.price || 0);
  const paymentCurrency = String(paymentData?.currency_id || selectedPlan.currency || 'USD').toUpperCase();
  const paidAtRaw = paymentData?.date_approved || paymentData?.date_created || null;
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : new Date();
  const copSnapshot = await buildCopSnapshot({
    amount: paymentAmount,
    currency: paymentCurrency,
    paidAt,
  });

  const dbData = {
    userId,
    provider: 'MERCADOPAGO',
    externalOrderId,
    externalCaptureId: String(paymentData?.order?.id || '').trim() || null,
    amount: paymentAmount,
    currency: paymentCurrency,
    status: mappedStatus,
    planType: planId,
    rawResponse: appendCopSnapshotToRawResponse(paymentData || null, copSnapshot),
    marketingCampaignId: attribution.marketingCampaignId,
    ...attribution.trackingForDb,
  };

  // Idempotencia: si este payment_id ya existe, actualizamos en vez de crear duplicado.
  const existingPayment = await prisma.payment.findFirst({
    where: {
      provider: 'MERCADOPAGO',
      externalOrderId,
    },
    orderBy: { id: 'desc' },
  });

  const wasCompleted = String(existingPayment?.status || '').toUpperCase() === 'COMPLETED';

  const paymentRecord = existingPayment
    ? await prisma.payment.update({
        where: { id: existingPayment.id },
        data: dbData,
      })
    : await prisma.payment.create({ data: dbData });

  const shouldActivateSubscription = mappedStatus === 'COMPLETED' && !wasCompleted;
  const activated = await applySubscriptionIfNeeded(userId, selectedPlan, shouldActivateSubscription);

  if (activated) {
    try {
      await prisma.notification.create({
        data: {
          title: `Nueva compra MercadoPago - Payment ${externalOrderId}`,
          body: [
            `Usuario ID: ${userId}`,
            `Plan: ${planId}`,
            `Monto: ${dbData.amount} ${dbData.currency}`,
            `Payment ID: ${externalOrderId}`,
            `Proveedor: MERCADOPAGO`,
          ].join('\n'),
          type: 'SALES',
          typeStatus: 'SUCCESS',
          status: 'UNREAD',
        },
      });
    } catch (notificationError) {
      console.error('No se pudo crear notificación de venta de MercadoPago:', notificationError);
    }
  }

  return {
    ok: true,
    statusCode: 200,
    status: mappedStatus,
    paymentRecord,
    activated,
    rawStatus: String(paymentData?.status || '').toLowerCase(),
  };
};

// Crea la preferencia de checkout y devuelve initPoint para redireccionar al usuario.
async function createMercadoPagoPreference(req, res) {
  const token = getAccessToken();
  if (!token) {
    return res.status(500).json({ error: 'MERCADOPAGO_ACCESS_TOKEN no configurado en backend' });
  }

  const planId = String(req.body?.planId || '').trim();
  const userId = parsePositiveInt(req.body?.userId);

  if (!planId || !userId) {
    return res.status(400).json({ error: 'Faltan datos para crear preferencia (planId, userId)' });
  }

  const selectedPlan = plans[planId];
  if (!selectedPlan) {
    return res.status(404).json({ error: `Plan '${planId}' no encontrado` });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: PAYMENT_USER_TRACKING_SELECT,
  });

  if (!user) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  const frontBase = ensureNoTrailingSlash(
    process.env.MERCADOPAGO_FRONT_RETURN_URL || process.env.FRONT_URL || 'http://localhost:3000'
  );
  const callbackUrl = `${frontBase}/payment/mercadopago/callback`;
  const externalReference = `uid:${userId}|plan:${planId}`;
  const attribution = await resolvePaymentAttribution({
    prismaLike: prisma,
    req,
    user,
  });
  const trackingMeta = attribution.mergedTracking || {};

  const payload = {
    items: [
      {
        id: planId,
        title: selectedPlan.name_es,
        description: selectedPlan.name_en,
        quantity: 1,
        currency_id: selectedPlan.currency,
        unit_price: Number(selectedPlan.price),
      },
    ],
    payer: user.email ? { email: user.email } : undefined,
    external_reference: externalReference,
    metadata: {
      userId,
      planId,
      source: 'stlhub-web',
      marketingCampaignId: attribution.marketingCampaignId || null,
      utmSource: trackingMeta.utmSource || null,
      utmMedium: trackingMeta.utmMedium || null,
      utmCampaign: trackingMeta.utmCampaign || null,
      utmContent: trackingMeta.utmContent || null,
      utmTerm: trackingMeta.utmTerm || null,
      clickGclid: trackingMeta.clickGclid || null,
      clickFbclid: trackingMeta.clickFbclid || null,
      clickTtclid: trackingMeta.clickTtclid || null,
      clickMsclkid: trackingMeta.clickMsclkid || null,
    },
    statement_descriptor: 'STL HUB',
    back_urls: {
      success: callbackUrl,
      pending: callbackUrl,
      failure: callbackUrl,
    },
    notification_url: getWebhookUrl(req),
    binary_mode: false,
  };

  // auto_return requiere back_url.success publica/https; en localhost suele fallar con invalid_auto_return.
  if (shouldSendAutoReturn(callbackUrl)) {
    payload.auto_return = 'approved';
  }

  try {
    const preference = await mpRequest('/checkout/preferences', {
      method: 'POST',
      body: payload,
      accessToken: token,
      headers: {
        'X-Idempotency-Key': `pref-${externalReference}-${Date.now()}`,
      },
    });

    return res.json({
      success: true,
      preferenceId: preference?.id || null,
      initPoint: preference?.init_point || preference?.sandbox_init_point || null,
      sandboxInitPoint: preference?.sandbox_init_point || null,
    });
  } catch (error) {
    console.error('Error creando preferencia de MercadoPago:', error?.details || error);
    return res.status(500).json({
      error: 'No se pudo crear la preferencia en MercadoPago',
      details: error?.details || null,
    });
  }
}

// Endpoint llamado por el frontend al volver del checkout de MercadoPago.
// Consulta el payment_id real y delega el guardado/activacion al procesador comun.
async function captureMercadoPagoPayment(req, res) {
  const token = getAccessToken();
  if (!token) {
    return res.status(500).json({ error: 'MERCADOPAGO_ACCESS_TOKEN no configurado en backend' });
  }

  const paymentIdRaw = req.body?.paymentId || req.body?.collection_id;
  const paymentId = String(paymentIdRaw || '').trim();

  if (!paymentId) {
    return res.status(400).json({ error: 'paymentId es requerido para confirmar el pago' });
  }

  try {
    const paymentData = await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      accessToken: token,
    });

    const processed = await processMercadoPagoPayment({ paymentData, req });
    if (!processed.ok) {
      return res.status(processed.statusCode || 400).json({
        success: false,
        error: processed.message,
      });
    }

    return res.json({
      success: processed.status === 'COMPLETED',
      status: processed.status,
      rawStatus: processed.rawStatus,
      activated: processed.activated,
      paymentId,
    });
  } catch (error) {
    console.error('Error confirmando pago de MercadoPago:', error?.details || error);
    return res.status(500).json({
      error: 'No se pudo confirmar el pago en MercadoPago',
      details: error?.details || null,
    });
  }
}

// Endpoint de notificaciones asincronas de MercadoPago.
// Es clave para medios diferidos (pending) donde la aprobacion llega despues.
async function mercadoPagoWebhook(req, res) {
  const token = getAccessToken();
  if (!token) {
    return res.status(500).json({ error: 'MERCADOPAGO_ACCESS_TOKEN no configurado en backend' });
  }

  const topic = String(
    req.query?.type || req.query?.topic || req.body?.type || req.body?.topic || ''
  )
    .trim()
    .toLowerCase();

  const queryDataId = req.query?.['data.id'];
  const bodyDataId = req.body?.data?.id;
  const paymentId = String(queryDataId || bodyDataId || req.query?.id || req.body?.id || '').trim();

  if (!paymentId || (topic && !topic.includes('payment'))) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const paymentData = await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      accessToken: token,
    });

    const processed = await processMercadoPagoPayment({ paymentData, req });
    if (!processed.ok) {
      return res.status(processed.statusCode || 400).json({
        received: true,
        processed: false,
        error: processed.message,
      });
    }

    return res.status(200).json({
      received: true,
      processed: true,
      status: processed.status,
      paymentId,
    });
  } catch (error) {
    console.error('Error procesando webhook de MercadoPago:', error?.details || error);
    return res.status(500).json({
      received: true,
      processed: false,
      error: 'No se pudo procesar webhook de MercadoPago',
    });
  }
}

export {
  createMercadoPagoPreference,
  captureMercadoPagoPayment,
  mercadoPagoWebhook,
};

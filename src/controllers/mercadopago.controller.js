import { getPlans } from '../config/plans.js';
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
import { dispatchSaleNotification } from '../utils/saleNotifications.js';
import { sendTikTokEvent } from '../utils/tiktokCapi.js';
import { sendMetaEvent } from '../utils/metaCapi.js';
import {
  addAttemptEvent,
  createPaymentAttempt,
  createWebhookLog,
  findAttemptBy,
  findOwnedAttempt,
  finishWebhookLog,
  mapMercadoPagoStatusToAttempt,
  updateAttempt,
} from '../utils/paymentAttempts.js';

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
  if (!raw) return { userId: null, planId: null, attemptId: null };

  let match = raw.match(/^uid:(\d+)\|plan:([a-z0-9]+)(?:\|att:(\d+))?$/i);
  if (match) {
    return {
      userId: parsePositiveInt(match[1]),
      planId: String(match[2] || '').trim() || null,
      attemptId: parsePositiveInt(match[3]),
    };
  }

  match = raw.match(/^user-(\d+)_plan-([a-z0-9]+)$/i);
  if (match) {
    return {
      userId: parsePositiveInt(match[1]),
      planId: String(match[2] || '').trim() || null,
      attemptId: null,
    };
  }

  return { userId: null, planId: null, attemptId: null };
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
    orderBy: { currentPeriodEnd: 'desc' },
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
// Registra en el intento lo que MercadoPago dice de este pago (estado, motivo, medio de pago).
const trackMercadoPagoAttempt = async ({ paymentData, parsedReference, paymentRecord, source }) => {
  const externalPaymentId = String(paymentData?.id || '').trim();
  let attempt = null;
  if (parsedReference?.attemptId) {
    attempt = await findOwnedAttempt(prisma, {
      attemptId: parsedReference.attemptId,
      userId: parsedReference.userId,
      provider: 'MERCADOPAGO',
    });
  }
  if (!attempt && externalPaymentId) {
    attempt = await findAttemptBy(prisma, { provider: 'MERCADOPAGO', externalPaymentId });
  }
  if (!attempt) return null;

  const mpStatus = String(paymentData?.status || '').toLowerCase();
  const statusDetail = String(paymentData?.status_detail || '').trim() || null;
  const attemptStatus = mapMercadoPagoStatusToAttempt(mpStatus);
  const paymentMethod = [paymentData?.payment_type_id, paymentData?.payment_method_id].filter(Boolean).join(':') || null;

  await addAttemptEvent(prisma, attempt.id, {
    type: 'provider_status',
    source,
    status: mpStatus || null,
    detail: statusDetail,
    dedupe: true,
    data: {
      paymentId: externalPaymentId || null,
      status: mpStatus || null,
      statusDetail,
      paymentTypeId: paymentData?.payment_type_id || null,
      paymentMethodId: paymentData?.payment_method_id || null,
      installments: paymentData?.installments ?? null,
      amount: paymentData?.transaction_amount ?? null,
      currency: paymentData?.currency_id || null,
      merchantOrderId: paymentData?.order?.id || null,
      dateCreated: paymentData?.date_created || null,
      dateApproved: paymentData?.date_approved || null,
      dateLastUpdated: paymentData?.date_last_updated || null,
    },
  });

  return updateAttempt(prisma, attempt, {
    status: attemptStatus,
    fromProvider: true,
    statusDetail,
    paymentMethod,
    externalPaymentId: externalPaymentId || undefined,
    paymentId: paymentRecord?.id || undefined,
    amount: Number(paymentData?.transaction_amount) || undefined,
    currency: paymentData?.currency_id ? String(paymentData.currency_id).toUpperCase() : undefined,
    paidAt: attemptStatus === 'APPROVED' && !attempt.paidAt
      ? new Date(paymentData?.date_approved || Date.now())
      : undefined,
  });
};

const processMercadoPagoPayment = async ({ paymentData, req, source = 'server' }) => {
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

  const plans = await getPlans();
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

  const trackedAttempt = await trackMercadoPagoAttempt({ paymentData, parsedReference, paymentRecord, source });

  const shouldActivateSubscription = mappedStatus === 'COMPLETED' && !wasCompleted;
  const activated = await applySubscriptionIfNeeded(userId, selectedPlan, shouldActivateSubscription);

  if (activated) {
    await dispatchSaleNotification({
      prismaLike: prisma,
      provider: 'MERCADOPAGO',
      orderId: externalOrderId,
      userId,
      buyerEmail: user?.email,
      planName: selectedPlan?.name_es || planId,
      planNameEn: selectedPlan?.name_en || selectedPlan?.name_es || planId,
      amount: dbData.amount,
      currency: dbData.currency,
      userLanguage: user?.language || 'es',
    });

    // Evento de Servidor: TikTok CAPI (CompletePayment)
    sendTikTokEvent({
      eventName: 'CompletePayment',
      eventId: externalOrderId,
      userEmail: user?.email,
      userIp: req.ip,
      userAgent: req.headers['user-agent'],
      value: dbData.amount,
      currency: dbData.currency
    });

    // Evento de Servidor: Meta CAPI (CompletePayment)
    sendMetaEvent({
      eventName: 'CompletePayment',
      eventId: externalOrderId,
      userEmail: user?.email,
      userIp: req.ip,
      userAgent: req.headers['user-agent'],
      value: dbData.amount,
      currency: dbData.currency
    });
  }

  return {
    ok: true,
    statusCode: 200,
    status: mappedStatus,
    paymentRecord,
    activated,
    attemptId: trackedAttempt?.id || null,
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

  const plans = await getPlans();
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
  const attribution = await resolvePaymentAttribution({
    prismaLike: prisma,
    req,
    user,
  });

  // Intento de pago: usa el que creó el front al elegir el método, o crea uno nuevo.
  let attempt = await findOwnedAttempt(prisma, { attemptId: req.body?.attemptId, userId, provider: 'MERCADOPAGO' });
  if (!attempt) {
    attempt = await createPaymentAttempt(prisma, { req, userId, provider: 'MERCADOPAGO', planId, attribution });
  }
  const externalReference = attempt?.id
    ? `uid:${userId}|plan:${planId}|att:${attempt.id}`
    : `uid:${userId}|plan:${planId}`;
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

    attempt = await updateAttempt(prisma, attempt, {
      status: 'CHECKOUT_CREATED',
      externalCheckoutId: preference?.id || undefined,
      amount: Number(selectedPlan.price),
      currency: String(selectedPlan.currency || 'USD').toUpperCase(),
      checkoutCreatedAt: new Date(),
    });
    await addAttemptEvent(prisma, attempt?.id, {
      type: 'checkout_created',
      source: 'server',
      status: 'CHECKOUT_CREATED',
      detail: preference?.id || null,
    });

    return res.json({
      success: true,
      preferenceId: preference?.id || null,
      attemptId: attempt?.id || null,
      initPoint: preference?.init_point || preference?.sandbox_init_point || null,
      sandboxInitPoint: preference?.sandbox_init_point || null,
    });
  } catch (error) {
    console.error('Error creando preferencia de MercadoPago:', error?.details || error);
    const errorText = `${error?.message || error} ${JSON.stringify(error?.details ?? '')}`;
    await addAttemptEvent(prisma, attempt?.id, {
      type: 'checkout_create_failed',
      source: 'server',
      status: 'ERROR',
      detail: errorText,
      data: { httpStatus: error?.status || null },
    });
    await updateAttempt(prisma, attempt, { status: 'ERROR', lastError: errorText.slice(0, 2000) });
    return res.status(500).json({
      error: 'No se pudo crear la preferencia en MercadoPago',
      details: error?.details || null,
    });
  }
}

// Error nuestro al confirmar el pago desde el callback: lo deja en el intento (si lo encontramos).
const recordCaptureFailure = async (req, paymentId, message) => {
  // /capture no exige sesión: solo enlazamos por ids de MercadoPago (no por attemptId del body).
  const preferenceId = String(req.body?.preferenceId || '').trim();
  let attempt = null;
  if (paymentId) {
    attempt = await findAttemptBy(prisma, { provider: 'MERCADOPAGO', externalPaymentId: String(paymentId) });
  }
  if (!attempt && preferenceId) {
    attempt = await findAttemptBy(prisma, { provider: 'MERCADOPAGO', externalCheckoutId: preferenceId });
  }
  if (!attempt) return;
  const text = String(message || '');
  await addAttemptEvent(prisma, attempt.id, {
    type: 'confirm_failed',
    source: 'callback',
    status: 'ERROR',
    detail: text,
    data: { paymentId: paymentId || null },
  });
  await updateAttempt(prisma, attempt, { status: 'ERROR', lastError: text.slice(0, 2000) });
};

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

    const processed = await processMercadoPagoPayment({ paymentData, req, source: 'callback' });
    if (!processed.ok) {
      await recordCaptureFailure(req, paymentId, processed.message);
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
      amount: processed.paymentRecord?.amount || 0,
      currency: processed.paymentRecord?.currency || 'USD',
    });
  } catch (error) {
    console.error('Error confirmando pago de MercadoPago:', error?.details || error);
    await recordCaptureFailure(req, paymentId, `${error?.message || error} ${JSON.stringify(error?.details ?? '')}`);
    try {
      await prisma.notification.create({
        data: {
          title: 'Fallo al confirmar pago - MercadoPago',
          body: `No se pudo confirmar o registrar el pago de MercadoPago.\nPayment ID: ${paymentId || 'N/D'}\nError: ${error.message || error?.details || error}`,
          type: 'BILLING',
          typeStatus: 'ERROR',
          status: 'UNREAD',
        }
      });
    } catch (nErr) {
      console.error('Failed to create BILLING notification for MercadoPago capture error:', nErr.message);
    }
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

  const webhookLog = await createWebhookLog(prisma, {
    provider: 'MERCADOPAGO',
    topic: topic || null,
    externalId: paymentId || null,
    payload: { query: req.query || null, body: req.body || null },
  });

  if (!paymentId || (topic && !topic.includes('payment'))) {
    await finishWebhookLog(prisma, webhookLog, { processed: false, httpStatus: 200, error: 'ignored' });
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const paymentData = await mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      accessToken: token,
    });

    const processed = await processMercadoPagoPayment({ paymentData, req, source: 'webhook' });
    if (!processed.ok) {
      await finishWebhookLog(prisma, webhookLog, {
        processed: false,
        httpStatus: processed.statusCode || 400,
        error: processed.message,
      });
      return res.status(processed.statusCode || 400).json({
        received: true,
        processed: false,
        error: processed.message,
      });
    }

    await finishWebhookLog(prisma, webhookLog, {
      processed: true,
      httpStatus: 200,
      attemptId: processed.attemptId,
    });
    return res.status(200).json({
      received: true,
      processed: true,
      status: processed.status,
      paymentId,
    });
  } catch (error) {
    console.error('Error procesando webhook de MercadoPago:', error?.details || error);
    await finishWebhookLog(prisma, webhookLog, {
      processed: false,
      httpStatus: 500,
      error: `${error?.message || error} ${JSON.stringify(error?.details ?? '')}`,
    });
    try {
      await prisma.notification.create({
        data: {
          title: 'Fallo procesando Webhook - MercadoPago',
          body: `No se pudo procesar la notificación de pago de MercadoPago.\nPayment ID: ${paymentId || 'N/D'}\nTopic: ${topic || 'N/D'}\nError: ${error.message || error?.details || error}`,
          type: 'BILLING',
          typeStatus: 'ERROR',
          status: 'UNREAD',
        }
      });
    } catch (nErr) {
      console.error('Failed to create BILLING notification for MercadoPago webhook error:', nErr.message);
    }
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

import paypal from '@paypal/checkout-server-sdk';
import { getPlans } from '../config/plans.js';
import { PrismaClient } from '@prisma/client';
import {
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
    findAttemptBy,
    findOwnedAttempt,
    updateAttempt,
} from '../utils/paymentAttempts.js';

const prisma = new PrismaClient();

// El SDK de PayPal lanza HttpError con el cuerpo JSON en `message`.
const parsePayPalError = (e) => {
    let body = null;
    try { body = JSON.parse(e?.message || ''); } catch { body = null; }
    const issue = body?.details?.[0]?.issue || null;
    return {
        httpStatus: e?.statusCode || null,
        name: body?.name || null,
        issue,
        description: body?.details?.[0]?.description || body?.message || (body ? null : e?.message) || null,
        debugId: body?.debug_id || null,
    };
};

// Problemas del medio de pago (no son errores nuestros).
const PAYPAL_DECLINE_ISSUES = new Set([
    'INSTRUMENT_DECLINED',
    'PAYER_ACTION_REQUIRED',
    'PAYER_CANNOT_PAY',
    'TRANSACTION_REFUSED',
    'CARD_EXPIRED',
    'PAYEE_BLOCKED_TRANSACTION',
    'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED',
]);

const payPalMethodFromSource = (source) => {
    if (!source || typeof source !== 'object') return null;
    if (source.card) return `card:${String(source.card.brand || source.card.type || 'unknown').toLowerCase()}`;
    const key = Object.keys(source)[0];
    return key || null;
};

const mapPayPalCaptureStatus = (statusRaw) => {
    const status = String(statusRaw || '').toUpperCase();
    if (status === 'COMPLETED') return 'APPROVED';
    if (status === 'PENDING') return 'PENDING';
    if (status === 'DECLINED' || status === 'FAILED') return 'REJECTED';
    if (status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED') return 'REFUNDED';
    return null;
};

// Funcion cliente PayPal
function client() {
    const environment =
        process.env.PAYPAL_ENV === 'live'
            ? new paypal.core.LiveEnvironment(
                  process.env.PAYPAL_CLIENT_ID,
                  process.env.PAYPAL_CLIENT_SECRET
              )
            : new paypal.core.SandboxEnvironment(
                  process.env.PAYPAL_CLIENT_ID,
                  process.env.PAYPAL_CLIENT_SECRET
              );
    return new paypal.core.PayPalHttpClient(environment);
}

// Crear orden de pago
async function createPayPalOrder(req, res) {
    const { planId, userId } = req.body;

    if (!planId || !userId) {
        return res.status(400).json({ error: 'Faltan datos para crear la orden (planId, userId)' });
    }

    // 1. Búsqueda eficiente y segura en el objeto de planes (precios dinámicos)
    const plans = await getPlans();
    const selectedPlan = plans[planId];
    
    if (!selectedPlan) {
        return res.status(404).json({ error: `El plan con id '${planId}' no fue encontrado.` });
    }

    console.log('Selected plan:', selectedPlan);

    // Intento de pago: usa el que creó el front al elegir el método, o crea uno nuevo.
    let attempt = await findOwnedAttempt(prisma, { attemptId: req.body?.attemptId, userId, provider: 'PAYPAL' });
    if (!attempt) {
        const user = await prisma.user.findUnique({
            where: { id: parseInt(userId) || 0 },
            select: PAYMENT_USER_TRACKING_SELECT,
        });
        const attribution = user ? await resolvePaymentAttribution({ prismaLike: prisma, req, user }) : null;
        attempt = await createPaymentAttempt(prisma, {
            req,
            userId: parseInt(userId) || null,
            provider: 'PAYPAL',
            planId,
            attribution,
        });
    }

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
            amount: {
                // 2. Usar datos del plan, no valores hardcodeados
                currency_code: selectedPlan.currency,
                value: selectedPlan.price
            },
            // 3. Añadir información útil para el usuario y para ti
            description: selectedPlan.name_es,
            custom_id: `user-${userId}_plan-${planId}`
        }],
    });

    try {
        const response = await client().execute(request);

        attempt = await updateAttempt(prisma, attempt, {
            status: 'CHECKOUT_CREATED',
            externalCheckoutId: response.result.id,
            amount: Number.parseFloat(selectedPlan.price) || undefined,
            currency: String(selectedPlan.currency || 'USD').toUpperCase(),
            checkoutCreatedAt: new Date(),
        });
        await addAttemptEvent(prisma, attempt?.id, {
            type: 'checkout_created',
            source: 'server',
            status: 'CHECKOUT_CREATED',
            detail: response.result.id,
        });

        return res.json({ id: response.result.id, attemptId: attempt?.id || null });
    } catch (e) {
        console.error('Error al crear la orden en PayPal:', e.message);
        const err = parsePayPalError(e);
        await addAttemptEvent(prisma, attempt?.id, {
            type: 'checkout_create_failed',
            source: 'server',
            status: 'ERROR',
            detail: err.issue || err.name || err.description,
            data: err,
        });
        await updateAttempt(prisma, attempt, { status: 'ERROR', lastError: JSON.stringify(err).slice(0, 2000) });
        return res.status(500).json({ error: 'No se pudo crear la orden de pago en PayPal.' });
    }
}


// Capturar orden de pago
async function capturePayPalOrder(req, res) {
    // 1. Recibir TODOS los datos necesarios del frontend
    const { orderID, planId, userId, } = req.body;

    if (!orderID || !planId || !userId) {
        return res.status(400).json({ error: 'Faltan datos para capturar la orden (orderID, planId, userId)' });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderID);

    request.requestBody({});

    const attempt = await findAttemptBy(prisma, { provider: 'PAYPAL', externalCheckoutId: String(orderID) });
    let capturedOk = false;

    try {
        const capture = await client().execute(request);
        const captureResult = capture.result;
        const firstCapture = captureResult?.purchase_units?.[0]?.payments?.captures?.[0] || null;
        const attemptStatus = mapPayPalCaptureStatus(firstCapture?.status)
            || (captureResult?.status === 'COMPLETED' ? 'APPROVED' : null);
        const captureReason = firstCapture?.status_details?.reason || null;
        capturedOk = captureResult?.status === 'COMPLETED';

        await addAttemptEvent(prisma, attempt?.id, {
            type: 'provider_status',
            source: 'server',
            status: String(firstCapture?.status || captureResult?.status || '').toLowerCase() || null,
            detail: captureReason,
            data: {
                orderStatus: captureResult?.status || null,
                captureId: firstCapture?.id || null,
                captureStatus: firstCapture?.status || null,
                captureReason,
                paymentSource: payPalMethodFromSource(captureResult?.payment_source),
                payerCountry: captureResult?.payer?.address?.country_code || null,
                processorResponse: firstCapture?.processor_response
                    ? JSON.stringify(firstCapture.processor_response).slice(0, 300)
                    : null,
                amount: firstCapture?.amount?.value || null,
                currency: firstCapture?.amount?.currency_code || null,
            },
        });
        await updateAttempt(prisma, attempt, {
            status: attemptStatus,
            fromProvider: true,
            statusDetail: captureReason,
            paymentMethod: payPalMethodFromSource(captureResult?.payment_source),
            externalPaymentId: firstCapture?.id || undefined,
            paidAt: attemptStatus === 'APPROVED' ? new Date(firstCapture?.create_time || Date.now()) : undefined,
        });

        // 2. VERIFICAR que el pago se completó
        if (captureResult.status === 'COMPLETED') {
            
            // 3. GUARDAR el pago en nuestra base de datos
            const plans = await getPlans();
            const selectedPlan = plans[planId];
            const parsedUserId = parseInt(userId);

            const user = await prisma.user.findUnique({
                where: { id: parsedUserId },
                select: PAYMENT_USER_TRACKING_SELECT,
            });

            if (!user) {
                await addAttemptEvent(prisma, attempt?.id, {
                    type: 'post_capture_failed',
                    source: 'server',
                    status: 'ERROR',
                    detail: `Usuario ${userId} no encontrado tras cobrar`,
                });
                return res.status(404).json({ error: 'Usuario no encontrado.' });
            }

            const attribution = await resolvePaymentAttribution({
                prismaLike: prisma,
                req,
                user,
            });

            const captureAmountValue = Number(
                captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value
            );
            const paymentAmount = Number.isFinite(captureAmountValue) && captureAmountValue > 0
                ? captureAmountValue
                : Number.parseFloat(selectedPlan.price);
            const paymentCurrency = String(
                captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code
                || selectedPlan.currency
                || 'USD'
            ).toUpperCase();
            const paidAtRaw = captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.create_time;
            const paidAt = paidAtRaw ? new Date(paidAtRaw) : new Date();
            const copSnapshot = await buildCopSnapshot({
                amount: paymentAmount,
                currency: paymentCurrency,
                paidAt,
            });

            const newPayment = await prisma.payment.create({
                data: {
                    userId: parsedUserId,
                    provider: 'PAYPAL',
                    externalOrderId: captureResult.id, // ID de la transacción de PayPal
                    amount: paymentAmount,
                    currency: paymentCurrency,
                    status: 'COMPLETED',
                    planType: planId, // Guarda el plan comprado
                    rawResponse: appendCopSnapshotToRawResponse(captureResult, copSnapshot),
                    marketingCampaignId: attribution.marketingCampaignId,
                    ...attribution.trackingForDb,
                }
            });

            // 4. ACTUALIZAR la suscripción del usuario
            const userSubscription = await prisma.subscription.findFirst({
                where: { userId: parsedUserId },
                orderBy: { currentPeriodEnd: 'desc' }
            });

            const now = new Date();
            // Si el usuario ya tiene una suscripción activa, la extendemos. Si no, creamos una nueva desde hoy.
            const startDate = userSubscription && userSubscription.currentPeriodEnd > now 
                ? userSubscription.currentPeriodEnd 
                : now;
            
            const newExpiryDate = new Date(startDate);
            newExpiryDate.setDate(newExpiryDate.getDate() + selectedPlan.durationDays);

            await prisma.subscription.upsert({
                where: { id: userSubscription?.id || 0 }, // Un ID que no existirá para forzar la creación
                update: {
                    currentPeriodEnd: newExpiryDate,
                    status: 'ACTIVE'
                },
                create: {
                    userId: parsedUserId,
                    currentPeriodEnd: newExpiryDate,
                    status: 'ACTIVE'
                }
            });

            console.log(`Pago ${newPayment.id} guardado y suscripción actualizada para el usuario ${userId}.`);
            await updateAttempt(prisma, attempt, { paymentId: newPayment.id });

            // --- Envío de correos ---
            try {
                const buyerEmail = user?.email;

                await dispatchSaleNotification({
                    prismaLike: prisma,
                    provider: newPayment?.provider || 'PAYPAL',
                    orderId: captureResult.id,
                    userId: parsedUserId,
                    buyerEmail,
                    planName: selectedPlan?.name_es || planId,
                    planNameEn: selectedPlan?.name_en || selectedPlan?.name_es || planId,
                    amount: paymentAmount,
                    currency: paymentCurrency,
                    userLanguage: user?.language || 'es',
                });
            } catch (mailErr) {
                console.error('Error enviando correos tras la captura de PayPal:', mailErr);
                // No interrumpimos el flujo por un fallo en el envío de emails
            }

            // Evento de Servidor: TikTok CAPI (CompletePayment)
            sendTikTokEvent({
                eventName: 'CompletePayment',
                eventId: captureResult.id,
                userEmail: user?.email,
                userIp: req.ip,
                userAgent: req.headers['user-agent'],
                value: paymentAmount,
                currency: paymentCurrency
            });

            // Evento de Servidor: Meta CAPI (CompletePayment)
            sendMetaEvent({
                eventName: 'CompletePayment',
                eventId: captureResult.id,
                userEmail: user?.email,
                userIp: req.ip,
                userAgent: req.headers['user-agent'],
                value: paymentAmount,
                currency: paymentCurrency
            });

            return res.json({ 
                success: true, 
                capture: captureResult,
                amount: paymentAmount,
                currency: paymentCurrency
            });
        } else {
            return res.status(400).json({ error: 'El pago no fue completado por PayPal.' });
        }

    } catch (e) {
        console.error('Error al capturar la orden de PayPal:', e);
        const err = parsePayPalError(e);
        if (capturedOk) {
            // PayPal cobró pero falló algo nuestro (guardar pago / activar suscripción). Es lo más grave.
            await addAttemptEvent(prisma, attempt?.id, {
                type: 'post_capture_failed',
                source: 'server',
                status: 'ERROR',
                detail: String(e?.message || e),
            });
            await updateAttempt(prisma, attempt, { lastError: `post_capture_failure: ${e?.message || e}`.slice(0, 2000) });
        } else {
            const declined = PAYPAL_DECLINE_ISSUES.has(err.issue);
            await addAttemptEvent(prisma, attempt?.id, {
                type: declined ? 'capture_declined' : 'capture_failed',
                source: 'server',
                status: declined ? 'REJECTED' : 'ERROR',
                detail: err.issue || err.name || err.description,
                data: err,
            });
            await updateAttempt(prisma, attempt, {
                status: declined ? 'REJECTED' : 'ERROR',
                fromProvider: declined,
                statusDetail: declined ? err.issue : undefined,
                lastError: JSON.stringify(err).slice(0, 2000),
            });
        }
        try {
            await prisma.notification.create({
                data: {
                    title: 'Fallo al capturar orden - PayPal',
                    body: `No se pudo capturar o registrar la orden de PayPal.\nOrder ID: ${orderID || 'N/D'}\nUser ID: ${userId || 'N/D'}\nPlan ID: ${planId || 'N/D'}\nError: ${e.message || e}`,
                    type: 'BILLING',
                    typeStatus: 'ERROR',
                    status: 'UNREAD',
                }
            });
        } catch (nErr) {
            console.error('Failed to create BILLING notification for PayPal error:', nErr.message);
        }
        return res.status(500).json({ error: 'Error capturando la orden de PayPal' });
    }
}


export { createPayPalOrder, capturePayPalOrder };
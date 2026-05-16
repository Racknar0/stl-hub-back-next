import crypto from 'crypto';

/**
 * Hashea un string (como email o teléfono) usando SHA-256 según los requisitos de TikTok.
 */
const hashData = (data) => {
    if (!data) return undefined;
    const cleanData = String(data).trim().toLowerCase();
    if (!cleanData) return undefined;
    return crypto.createHash('sha256').update(cleanData).digest('hex');
};

/**
 * Envía un evento a la API de Conversiones de TikTok (CAPI)
 * 
 * @param {Object} params
 * @param {string} params.eventName - 'CompleteRegistration' | 'CompletePayment'
 * @param {string} params.eventId - ID único para deduplicación (mismo que se envía desde frontend)
 * @param {string} params.userEmail - Correo del usuario (se hasheará automáticamente)
 * @param {string} params.userIp - Dirección IP del usuario
 * @param {string} params.userAgent - User-Agent del navegador del usuario
 * @param {number} [params.value] - Valor total de la transacción (requerido para compras)
 * @param {string} [params.currency] - Moneda de la transacción (ej. 'USD')
 */
export const sendTikTokEvent = async ({
    eventName,
    eventId,
    userEmail,
    userIp,
    userAgent,
    value,
    currency = 'USD'
}) => {
    try {
        const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
        const pixelId = process.env.TIKTOK_PIXEL_ID;

        // Si no están configuradas las variables, saltamos silenciosamente para no romper el flujo
        if (!accessToken || !pixelId) {
            console.warn('[TikTok CAPI] Variables TIKTOK_ACCESS_TOKEN o TIKTOK_PIXEL_ID no están configuradas.');
            return;
        }

        const hashedEmail = hashData(userEmail);

        // Construimos el payload de acuerdo a la API de Eventos v1.3 de TikTok
        const eventData = {
            event: eventName,
            event_time: Math.floor(Date.now() / 1000), // Timestamp en segundos
            event_id: eventId,
            user: {
                email: hashedEmail,
                ip: userIp || '127.0.0.1',
                user_agent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            }
        };

        // Si es un evento de valor (compra), añadimos las propiedades de e-commerce
        if (value !== undefined && value !== null) {
            eventData.properties = {
                contents: [{
                    price: Number(value),
                    quantity: 1,
                    content_id: 'stl-hub-subscription'
                }],
                currency: currency,
                value: Number(value)
            };
        }

        const payload = {
            event_source: "web",
            event_source_id: pixelId,
            data: [eventData]
        };

        // Si hay un código de prueba configurado (solo para depuración), lo añadimos a la raíz
        if (process.env.TIKTOK_TEST_EVENT_CODE) {
            payload.test_event_code = process.env.TIKTOK_TEST_EVENT_CODE;
        }

        console.log("\n=============================================");
        console.log("[TikTok CAPI] ENVIANDO EVENTO:", eventName);
        console.log("PAYLOAD COMPLETO:", JSON.stringify(payload, null, 2));

        const response = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
            method: 'POST',
            headers: {
                'Access-Token': accessToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        console.log("RESPUESTA TIKTOK:", result);
        console.log("=============================================\n");

        if (result.code === 0) {
            console.log(`[TikTok CAPI] Evento ${eventName} (ID: ${eventId}) enviado correctamente.`);
        } else {
            console.error(`[TikTok CAPI] Error de TikTok:`, result.message);
        }

    } catch (error) {
        console.error('[TikTok CAPI] Excepción al enviar evento:', error.message);
    }
};

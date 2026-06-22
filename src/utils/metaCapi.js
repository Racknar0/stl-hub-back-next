import crypto from 'crypto';

/**
 * Hashea un string (como email o teléfono) usando SHA-256 según los requisitos de Meta.
 */
const hashData = (data) => {
    if (!data) return undefined;
    const cleanData = String(data).trim().toLowerCase();
    if (!cleanData) return undefined;
    return crypto.createHash('sha256').update(cleanData).digest('hex');
};

/**
 * Envía un evento a la API de Conversiones de Meta (Facebook CAPI)
 * 
 * @param {Object} params
 * @param {string} params.eventName - 'CompleteRegistration' | 'CompletePayment' | 'InitiateCheckout' | 'PageView'
 * @param {string} params.eventId - ID único para deduplicación (mismo que se envía desde frontend)
 * @param {string} params.userEmail - Correo del usuario (se hasheará automáticamente)
 * @param {string} params.userIp - Dirección IP del usuario
 * @param {string} params.userAgent - User-Agent del navegador del usuario
 * @param {string} [params.fbc] - Cookie fbc de Facebook (opcional)
 * @param {string} [params.fbp] - Cookie fbp de Facebook (opcional)
 * @param {number} [params.value] - Valor total de la transacción (requerido para compras)
 * @param {string} [params.currency] - Moneda de la transacción (ej. 'USD')
 */
export const sendMetaEvent = async ({
    eventName,
    eventId,
    userEmail,
    userIp,
    userAgent,
    fbc,
    fbp,
    value,
    currency = 'USD'
}) => {
    try {
        const accessToken = process.env.META_ACCESS_TOKEN;
        const pixelId = process.env.META_PIXEL_ID;

        // Si no están configuradas las variables, saltamos silenciosamente
        if (!accessToken || !pixelId) {
            console.warn('[Meta CAPI] Variables META_ACCESS_TOKEN o META_PIXEL_ID no están configuradas.');
            return;
        }

        const hashedEmail = hashData(userEmail);

        // Construimos el user_data de acuerdo a la API de Conversiones de Meta
        const userData = {
            client_ip_address: userIp || '127.0.0.1',
            client_user_agent: userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        };

        if (hashedEmail) {
            userData.em = [hashedEmail];
        }
        if (fbc) {
            userData.fbc = fbc;
        }
        if (fbp) {
            userData.fbp = fbp;
        }

        const eventData = {
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000), // Timestamp en segundos
            event_id: eventId,
            user_data: userData,
            action_source: "website",
            event_source_url: eventName === 'CompleteRegistration' ? 'https://stl-hub.com/register' : 'https://stl-hub.com/'
        };

        // Si es un evento de valor (compra), añadimos las propiedades
        if (value !== undefined && value !== null) {
            eventData.custom_data = {
                currency: currency,
                value: Number(value)
            };
        }

        const payload = {
            data: [eventData]
        };

        // Si hay un código de prueba configurado (solo para depuración en panel de Meta), lo añadimos a la raíz
        if (process.env.META_TEST_EVENT_CODE) {
            payload.test_event_code = process.env.META_TEST_EVENT_CODE;
        }

        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.error) {
            console.error(`[Meta CAPI] Error de Meta:`, result.error.message);
        } else {
            console.log(`[Meta CAPI] Evento ${eventName} (ID: ${eventId}) enviado correctamente.`);
        }

    } catch (error) {
        console.error('[Meta CAPI] Excepción al enviar evento:', error.message);
    }
};

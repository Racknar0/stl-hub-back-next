import paypal from '@paypal/checkout-server-sdk';
import plans from '../config/plans.js';
import { PrismaClient } from '@prisma/client';
import { transporter } from './nodeMailerController.js';

const prisma = new PrismaClient();

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

    // 1. Búsqueda eficiente y segura en el objeto de planes
    const selectedPlan = plans[planId];
    
    if (!selectedPlan) {
        return res.status(404).json({ error: `El plan con id '${planId}' no fue encontrado.` });
    }

    console.log('Selected plan:', selectedPlan);

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
        return res.json({ id: response.result.id });
    } catch (e) {
        console.error('Error al crear la orden en PayPal:', e.message);
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

    try {
        const capture = await client().execute(request);
        const captureResult = capture.result;

        // 2. VERIFICAR que el pago se completó
        if (captureResult.status === 'COMPLETED') {
            
            // 3. GUARDAR el pago en nuestra base de datos
            const selectedPlan = plans[planId];
            const newPayment = await prisma.payment.create({
                data: {
                    userId: parseInt(userId),
                    provider: 'PAYPAL',
                    externalOrderId: captureResult.id, // ID de la transacción de PayPal
                    amount: parseFloat(selectedPlan.price),
                    currency: selectedPlan.currency,
                    status: 'COMPLETED',
                    planType: planId, // Guarda el plan comprado
                    rawResponse: JSON.stringify(captureResult), // Guarda toda la respuesta de PayPal
                }
            });

            // 4. ACTUALIZAR la suscripción del usuario
            const userSubscription = await prisma.subscription.findFirst({
                where: { userId: parseInt(userId) }
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
                    userId: parseInt(userId),
                    currentPeriodEnd: newExpiryDate,
                    status: 'ACTIVE'
                }
            });

            console.log(`Pago ${newPayment.id} guardado y suscripción actualizada para el usuario ${userId}.`);

            // --- Envío de correos ---
            try {
                // Obtener email del comprador desde la BD
                const user = await prisma.user.findUnique({ where: { id: parseInt(userId) } });
                const buyerEmail = user?.email;
                const sellerEmail = process.env.SELLER_EMAIL;
                const lang = user?.language || 'es';
                const isEn = String(lang).toLowerCase() === 'en';

                const dashboardLink = `${process.env.FRONT_URL}/`;

                // Texto plano y preheader
                const buyerPreheader = isEn
                    ? 'Thanks for your purchase. Order details inside.'
                    : 'Gracias por tu compra. Detalles del pedido dentro.';

                const buyerText = isEn
                    ? [
                        'Purchase confirmation',
                        '',
                        `Plan: ${selectedPlan?.name_es || planId}`,
                        `Amount: ${selectedPlan?.price} ${selectedPlan?.currency}`,
                        `Order ID: ${captureResult.id}`,
                        '',
                        'If you have questions, reply to this email.'
                    ].join('\n')
                    : [
                        'Confirmación de compra',
                        '',
                        `Plan: ${selectedPlan?.name_es || planId}`,
                        `Monto: ${selectedPlan?.price} ${selectedPlan?.currency}`,
                        `Order ID: ${captureResult.id}`,
                        '',
                        'Si tienes preguntas, responde a este correo.'
                    ].join('\n');

                // Email comprador: HTML con el mismo estilo que en auth.controller.js
                if (buyerEmail) {
                    await transporter.sendMail({
                        from: process.env.SMTP_EMAIL,
                        to: buyerEmail,
                        subject: isEn ? 'Purchase confirmation - STL Hub' : 'Confirmación de compra - STL Hub',
                        text: buyerText,
                        html: `
                            <!doctype html>
                            <html>
                            <head>
                                <meta charset="utf-8">
                                <meta name="viewport" content="width=device-width">
                                <style>
                                .preheader{display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all}
                                .btn{display:inline-block;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600}
                                @media (prefers-color-scheme: dark){
                                    body{background:#0b0b0c!important}
                                    .card{background:#111214!important;border-color:#2a2b2e!important}
                                    .text{color:#e6e7e9!important}
                                    .muted{color:#b5b7ba!important}
                                    .btn{background:#4f46e5!important;color:#fff!important}
                                }
                                </style>
                            </head>
                            <body style="margin:0;padding:0;background:#f6f7f9;">
                                <span class="preheader">${buyerPreheader}</span>

                                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
                                <tr><td align="center">
                                    <table role="presentation" width="100%" style="max-width:600px;">
                                    <tr><td class="card" style="background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,'Helvetica Neue',sans-serif;line-height:1.55;">

                                        <h1 class="text" style="margin:0 0 6px;font-size:20px;font-weight:700;color:#0f172a;">
                                        ${isEn ? 'Thank you for your purchase' : 'Gracias por tu compra'}
                                        </h1>

                                        <p class="muted" style="margin:0 0 18px;font-size:14px;color:#64748b;">
                                        ${isEn ? 'We have received your payment.' : 'Hemos recibido tu pago.'}
                                        </p>

                                        <p class="text" style="margin:0 0 20px;font-size:16px;color:#0f172a;">
                                        ${isEn ? 'Order details:' : 'Detalles de la compra:'}
                                        </p>

                                        <ul style="margin:0 0 18px;padding-left:18px;color:#0f172a;">
                                            <li>Plan: ${selectedPlan?.name_es || planId}</li>
                                            <li>Monto: ${selectedPlan?.price} ${selectedPlan?.currency}</li>
                                            <li>Order ID: ${captureResult.id}</li>
                                        </ul>

                                        <p style="margin:0 0 20px;">
                                        <a href="${dashboardLink}" class="btn" style="background:#4f46e5;color:#ffffff;">
                                            ${isEn ? 'Go to home' : 'Ir al inicio'}
                                        </a>
                                        </p>

                                        <hr style="border:none;border-top:1px solid #e6e8eb;margin:22px 0;">

                                        <p class="muted" style="margin:0 0 6px;font-size:12px;color:#64748b;">
                                        ${isEn ? 'If you have questions, reply to this email.' : 'Si tienes preguntas, responde a este correo.'}
                                        </p>
                                    </td></tr>
                                    </table>
                                </td></tr>
                                </table>
                            </body>
                            </html>
                        `.trim(),
                    });
                }

                // Email vendedor (notificación) — plantilla en ESPAÑOL (sin selección de idioma)
                if (sellerEmail) {
                    const sellerPreheader = 'Se realizó una nueva compra en tu sitio.';

                    const sellerText = [
                        'Notificación de nueva compra',
                        '',
                        `Usuario ID: ${userId}`,
                        `Usuario email: ${buyerEmail || 'N/D'}`,
                        `Plan: ${selectedPlan?.name_es || planId}`,
                        `Monto: ${selectedPlan?.price} ${selectedPlan?.currency}`,
                        `Order ID: ${captureResult.id}`,
                        `Proveedor: ${newPayment?.provider || 'PAYPAL'}`,
                    ].join('\n');

                    await transporter.sendMail({
                        from: process.env.SMTP_EMAIL,
                        to: sellerEmail,
                        subject: 'Nueva compra - STL Hub',
                        text: sellerText,
                        html: `
                            <!doctype html>
                            <html>
                            <head>
                                <meta charset="utf-8">
                                <meta name="viewport" content="width=device-width">
                                <style>
                                .preheader{display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all}
                                .btn{display:inline-block;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600}
                                @media (prefers-color-scheme: dark){
                                    body{background:#0b0b0c!important}
                                    .card{background:#111214!important;border-color:#2a2b2e!important}
                                    .text{color:#e6e7e9!important}
                                    .muted{color:#b5b7ba!important}
                                    .btn{background:#4f46e5!important;color:#fff!important}
                                }
                                </style>
                            </head>
                            <body style="margin:0;padding:0;background:#f6f7f9;">
                                <span class="preheader">${sellerPreheader}</span>

                                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
                                <tr><td align="center">
                                    <table role="presentation" width="100%" style="max-width:600px;">
                                    <tr><td class="card" style="background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,'Helvetica Neue',sans-serif;line-height:1.55;">

                                        <h1 class="text" style="margin:0 0 6px;font-size:20px;font-weight:700;color:#0f172a;">
                                        Nueva compra
                                        </h1>

                                        <p class="muted" style="margin:0 0 18px;font-size:14px;color:#64748b;">
                                        Un usuario completó una compra en el sitio.
                                        </p>

                                        <ul style="margin:0 0 18px;padding-left:18px;color:#0f172a;">
                                            <li>Usuario ID: ${userId}</li>
                                            <li>Usuario email: ${buyerEmail || 'No disponible'}</li>
                                            <li>Plan: ${selectedPlan?.name_es || planId}</li>
                                            <li>Monto: ${selectedPlan?.price} ${selectedPlan?.currency}</li>
                                            <li>Order ID: ${captureResult.id}</li>
                                            <li>Proveedor: ${newPayment?.provider || 'PAYPAL'}</li>
                                        </ul>

                                        <hr style="border:none;border-top:1px solid #e6e8eb;margin:22px 0;">

                                        <p class="muted" style="margin:0 0 6px;font-size:12px;color:#64748b;">
                                        Esta es una notificación automática.
                                        </p>
                                    </td></tr>
                                    </table>
                                </td></tr>
                                </table>
                            </body>
                            </html>
                        `.trim(),
                    });
                }
            } catch (mailErr) {
                console.error('Error enviando correos tras la captura de PayPal:', mailErr);
                // No interrumpimos el flujo por un fallo en el envío de emails
            }

            return res.json({ success: true, capture: captureResult });
        } else {
            return res.status(400).json({ error: 'El pago no fue completado por PayPal.' });
        }

    } catch (e) {
        console.error('Error al capturar la orden de PayPal:', e);
        return res.status(500).json({ error: 'Error capturando la orden de PayPal' });
    }
}


export { createPayPalOrder, capturePayPalOrder };
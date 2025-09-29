import paypal from '@paypal/checkout-server-sdk';
import plans from '../config/plans.js';
import { PrismaClient } from '@prisma/client';

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
    const { orderID, planId, userId } = req.body;

    if (!orderID || !planId || !userId) {
        return res.status(400).json({ error: 'Faltan datos para capturar la orden (orderID, planId, userId)' });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderID);
    console.log('request /*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*/*');
    console.log(request);

    request.requestBody({});

    try {
        const capture = await client().execute(request);
        const captureResult = capture.result;

        console.log('CAPTURE --------------------------');
        console.log(capture);
        console.log('CAPTURE RESULT **********************');
        console.log(captureResult);

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
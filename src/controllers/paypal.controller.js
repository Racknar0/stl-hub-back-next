import paypal from '@paypal/checkout-server-sdk';

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
async function createPayPalOrder(req, res) { // Agrega req y res como parámetros

    console.log('Creating PayPal order');
    console.log('req:' , req);

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: '9.99' } }], // Ejemplo: compra de $9.99 USD
    });
    try {
        const resPayPal = await client().execute(request); // Cambia el nombre de la variable para evitar confusión
        return res.json({ id: resPayPal.result.id }); // Usa res aquí
    } catch (e) {
        console.error('PayPal order creation error', e);
        return res.status(500).json({ error: 'Error creating PayPal order' }); // Usa res aquí
    }
}

// Capturar orden de pago
async function capturePayPalOrder(req, res) {
    const { orderID } = req.body;
    if (!orderID) return res.status(400).json({ error: 'orderID is required' });
    const request = new paypal.orders.OrdersCaptureRequest(orderID);
    request.requestBody({});
    try {
        const capture = await client().execute(request);
        return res.json({ capture: capture.result });
    } catch (e) {
        console.error('PayPal order capture error', e);
        return res.status(500).json({ error: 'Error capturing PayPal order' });
    }
}


export { createPayPalOrder, capturePayPalOrder };
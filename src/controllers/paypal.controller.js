import paypal from '@paypal/checkout-server-sdk';

// Funcion cliente PayPal
function client() {
  const environment = process.env.PAYPAL_ENV === 'live'
    ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
  return new paypal.core.PayPalHttpClient(environment);
}


// Crear orden de pago
export async function createPayPalOrder() {
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{ amount: { currency_code: 'USD', value: '9.99' } }] // Ejemplo: compra de $9.99 USD
  });
  try {
    const res = await client().execute(request);
    return Response.json({ id: res.result.id });
  } catch (e) {
    console.error('PayPal order creation error', e);
    return Response.json({ error: 'Error creating PayPal order' }, { status: 500 });
  }
}
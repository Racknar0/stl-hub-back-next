import { transporter } from '../controllers/nodeMailerController.js';

const providerLabel = (providerRaw) => {
  const provider = String(providerRaw || '').trim().toUpperCase();
  if (provider === 'PAYPAL') return 'PayPal';
  if (provider === 'MERCADOPAGO') return 'MercadoPago';
  return provider || 'Pasarela';
};

const safeAmountText = (amount, currency) => {
  const n = Number(amount || 0);
  const amountText = Number.isFinite(n) ? n.toFixed(2) : '0.00';
  return `${amountText} ${String(currency || 'USD').toUpperCase()}`;
};

export const dispatchSaleNotification = async ({
  prismaLike,
  provider,
  orderId,
  userId,
  buyerEmail,
  planName,
  planNameEn,
  amount,
  currency,
  userLanguage,
} = {}) => {
  const providerText = providerLabel(provider);
  const amountText = safeAmountText(amount, currency);
  const orderText = String(orderId || 'N/D');
  const planText = String(planName || 'N/D');
  const planTextEn = String(planNameEn || planText || 'N/D');
  const userIdText = Number.isFinite(Number(userId)) ? String(Number(userId)) : String(userId || 'N/D');
  const buyerEmailText = String(buyerEmail || 'N/D').trim() || 'N/D';
  const dashboardLink = `${String(process.env.FRONT_URL || '').replace(/\/+$/, '') || 'https://stl-hub.com'}/`;

  const isEn = String(userLanguage || 'es').toLowerCase() === 'en';
  const buyerPlanText = isEn ? planTextEn : planText;

  if (buyerEmailText !== 'N/D') {
    try {
      const buyerPreheader = isEn
        ? 'Thanks for your purchase. Order details inside.'
        : 'Gracias por tu compra. Detalles del pedido dentro.';

      const buyerText = isEn
        ? [
            'Purchase confirmation',
            '',
            `Plan: ${buyerPlanText}`,
            `Amount: ${amountText}`,
            `Order ID: ${orderText}`,
            '',
            'If you have questions, reply to this email.',
          ].join('\n')
        : [
            'Confirmación de compra',
            '',
            `Plan: ${buyerPlanText}`,
            `Monto: ${amountText}`,
            `Order ID: ${orderText}`,
            '',
            'Si tienes preguntas, responde a este correo.',
          ].join('\n');

      await transporter.sendMail({
        from: process.env.SMTP_EMAIL,
        to: buyerEmailText,
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
                      <li>Plan: ${buyerPlanText}</li>
                      <li>${isEn ? 'Amount' : 'Monto'}: ${amountText}</li>
                      <li>Order ID: ${orderText}</li>
                      <li>${isEn ? 'Provider' : 'Proveedor'}: ${providerText}</li>
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
    } catch (buyerMailError) {
      console.error(`[SALES][${providerText}] No se pudo enviar correo al comprador:`, buyerMailError);
    }
  }

  try {
    await prismaLike.notification.create({
      data: {
        title: `Nueva compra - ${providerText} - ${orderText}`,
        body: [
          `Usuario ID: ${userIdText}`,
          `Usuario email: ${buyerEmailText}`,
          `Plan: ${planText}`,
          `Monto: ${amountText}`,
          `Order ID: ${orderText}`,
          `Proveedor: ${providerText}`,
        ].join('\n'),
        type: 'SALES',
        typeStatus: 'SUCCESS',
        status: 'UNREAD',
      },
    });
  } catch (notificationError) {
    console.error(`[SALES][${providerText}] No se pudo crear notificación interna:`, notificationError);
  }

  const sellerEmail = String(process.env.SELLER_EMAIL || '').trim();
  if (!sellerEmail) return;

  try {
    const sellerText = [
      'Notificación de nueva compra',
      '',
      `Usuario ID: ${userIdText}`,
      `Usuario email: ${buyerEmailText}`,
      `Plan: ${planText}`,
      `Monto: ${amountText}`,
      `Order ID: ${orderText}`,
      `Proveedor: ${providerText}`,
    ].join('\n');

    await transporter.sendMail({
      from: process.env.SMTP_EMAIL,
      to: sellerEmail,
      subject: `Nueva compra - ${providerText} - STL Hub`,
      text: sellerText,
      html: `
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width">
          <style>
            .preheader{display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all}
            @media (prefers-color-scheme: dark){
              body{background:#0b0b0c!important}
              .card{background:#111214!important;border-color:#2a2b2e!important}
              .text{color:#e6e7e9!important}
              .muted{color:#b5b7ba!important}
            }
          </style>
        </head>
        <body style="margin:0;padding:0;background:#f6f7f9;">
          <span class="preheader">Se realizó una nueva compra en tu sitio.</span>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
            <tr><td align="center">
              <table role="presentation" width="100%" style="max-width:600px;">
                <tr><td class="card" style="background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,'Helvetica Neue',sans-serif;line-height:1.55;">
                  <h1 class="text" style="margin:0 0 6px;font-size:20px;font-weight:700;color:#0f172a;">Nueva compra</h1>
                  <p class="muted" style="margin:0 0 18px;font-size:14px;color:#64748b;">Un usuario completó una compra en el sitio.</p>
                  <ul style="margin:0 0 18px;padding-left:18px;color:#0f172a;">
                    <li>Usuario ID: ${userIdText}</li>
                    <li>Usuario email: ${buyerEmailText}</li>
                    <li>Plan: ${planText}</li>
                    <li>Monto: ${amountText}</li>
                    <li>Order ID: ${orderText}</li>
                    <li>Proveedor: ${providerText}</li>
                  </ul>
                  <hr style="border:none;border-top:1px solid #e6e8eb;margin:22px 0;">
                  <p class="muted" style="margin:0 0 6px;font-size:12px;color:#64748b;">Esta es una notificación automática.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `.trim(),
    });
  } catch (mailError) {
    console.error(`[SALES][${providerText}] No se pudo enviar correo al vendedor:`, mailError);
  }
};

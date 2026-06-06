import { transporter } from '../controllers/nodeMailerController.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Registra un fallo de publicación en la base de datos como notificación para el panel,
 * y opcionalmente envía una alerta por correo electrónico al administrador si está configurado.
 * 
 * @param {Object} params
 * @param {number|string} params.pinId - ID del pin en la cola (si existe).
 * @param {number|string} params.assetId - ID del asset asociado.
 * @param {string} params.title - Título del pin.
 * @param {string} params.errorMsg - Mensaje de error retornado.
 * @param {string} params.link - Enlace del pin.
 * @param {boolean} params.isImmediate - Si fue una publicación inmediata ("Publicar Ahora") o programada por worker.
 */
export const dispatchPinterestFailureNotification = async ({
  pinId,
  assetId,
  title,
  errorMsg,
  link,
  isImmediate = false
} = {}) => {
  // 1. Guardar la notificación interna en la Base de Datos (para que aparezca en la campana del Dashboard)
  try {
    await prisma.notification.create({
      data: {
        title: isImmediate 
          ? `Error al publicar Pin ahora (Asset #${assetId || 'now'})` 
          : `Error publicando Pin #${pinId} (Asset #${assetId})`,
        body: `Ocurrió un error al intentar publicar ${isImmediate ? 'manualmente' : 'automáticamente'} el Pin en Pinterest.\n\nError: ${errorMsg}\n\nTítulo del Pin: ${title || 'Sin título'}\n\nEnlace: ${link || 'Sin enlace'}`,
        status: 'UNREAD',
        type: 'AUTOMATION',
        typeStatus: 'ERROR'
      }
    });
    console.log(`[PINTEREST][NOTIFICATION] Notificación interna guardada para Pin #${pinId || 'now'}.`);
  } catch (notificationError) {
    console.error(`[PINTEREST][NOTIFICATION] No se pudo crear la notificación interna en la BD:`, notificationError.message);
  }

  // 2. Enviar correo electrónico al administrador (vendedor) si la variable de entorno está configurada
  const sellerEmail = String(process.env.SELLER_EMAIL || '').trim();
  if (!sellerEmail) {
    console.log('[PINTEREST][NOTIFICATION] SELLER_EMAIL no está configurado. Se omitirá el envío del correo de alerta.');
    return;
  }

  try {
    const subject = isImmediate 
      ? `❌ Error de Publicación Inmediata - Pinterest (Asset #${assetId || 'now'})`
      : `❌ Error de Publicación Programada - Pinterest (Pin #${pinId})`;

    const text = [
      'Alerta de fallo en Pinterest',
      '',
      `Pin ID en Cola: ${pinId || 'N/D'}`,
      `Asset ID: ${assetId || 'N/D'}`,
      `Título: ${title || 'Sin título'}`,
      `Enlace del Pin: ${link || 'Sin enlace'}`,
      `Método: ${isImmediate ? 'Manual (Publicar Ahora)' : 'Automático (Programado)'}`,
      `Error de la API: ${errorMsg}`,
      '',
      'Por favor, ingresa al planificador en el Dashboard para revisar los detalles del error, reintentar o eliminar la publicación.',
    ].join('\n');

    await transporter.sendMail({
      from: process.env.SMTP_EMAIL,
      to: sellerEmail,
      subject: subject,
      text: text,
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
              .error-box{background:#2a1415!important;border-color:#f87171!important;color:#f87171!important}
            }
          </style>
        </head>
        <body style="margin:0;padding:0;background:#f6f7f9;">
          <span class="preheader">Fallo al publicar un pin en Pinterest.</span>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
            <tr><td align="center">
              <table role="presentation" width="100%" style="max-width:600px;">
                <tr><td class="card" style="background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,'Helvetica Neue',sans-serif;line-height:1.55;">
                  <h1 class="text" style="margin:0 0 6px;font-size:20px;font-weight:700;color:#dc2626;">
                    Fallo en Publicación de Pinterest
                  </h1>
                  <p class="muted" style="margin:0 0 18px;font-size:14px;color:#64748b;">
                    Se ha detectado un error al intentar publicar un pin en tu cuenta de Pinterest.
                  </p>
                  
                  <div class="error-box" style="background:#fef2f2;border:1px solid #fee2e2;border-radius:6px;padding:12px;margin-bottom:18px;color:#991b1b;font-family:monospace;font-size:13px;word-break:break-all;">
                    <strong>Detalle del error de la API:</strong><br>
                    ${errorMsg}
                  </div>

                  <ul style="margin:0 0 18px;padding-left:18px;color:#0f172a;font-size:14px;">
                    <li><strong>Pin ID en Cola:</strong> ${pinId || 'N/D'}</li>
                    <li><strong>Asset ID:</strong> ${assetId || 'N/D'}</li>
                    <li><strong>Título del Pin:</strong> ${title || 'Sin título'}</li>
                    <li><strong>Enlace asociado:</strong> ${link ? `<a href="${link}" target="_blank" style="color:#4f46e5;">${link}</a>` : 'Sin enlace'}</li>
                    <li><strong>Método de publicación:</strong> ${isImmediate ? 'Manual (Publicar Ahora)' : 'Programado (Worker)'}</li>
                  </ul>
                  <hr style="border:none;border-top:1px solid #e6e8eb;margin:22px 0;">
                  <p class="muted" style="margin:0 0 6px;font-size:12px;color:#64748b;">Esta es una notificación automática del planificador de Pinterest de STL Hub.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body>
        </html>
      `.trim(),
    });
    console.log(`[PINTEREST][NOTIFICATION] Correo de alerta de fallo enviado con éxito a ${sellerEmail}.`);
  } catch (mailError) {
    console.error(`[PINTEREST][NOTIFICATION] No se pudo enviar el correo de alerta:`, mailError.message);
  }
};

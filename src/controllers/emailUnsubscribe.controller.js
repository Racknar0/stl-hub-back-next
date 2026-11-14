// Baja de correos de marketing desde el enlace del correo.
// El token va firmado (HMAC), así que no hace falta sesión.
//   GET  /api/email/unsubscribe/:token  -> página con botón de confirmación (NO da de baja)
//   POST /api/email/unsubscribe/:token  -> da de baja (botón de la página o cabecera List-Unsubscribe-Post)
//
// El GET no cambia nada a propósito: los antivirus y los lectores de correo abren los enlaces
// por su cuenta y darían de baja a la gente sin que lo pidiera.

import emailMarketing from '../services/emailMarketing.service.js';
import { verifyUnsubscribeToken } from '../services/emailEngine.service.js';

const page = (title, text, formAction = null) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:48px 16px;text-align:center;color:#1a202c">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
<h1 style="font-size:1.3rem;margin:0 0 12px">${title}</h1>
<p style="margin:0 0 ${formAction ? '20px' : '0'};color:#4a5568">${text}</p>
${formAction ? `<form method="post" action="${formAction}"><button type="submit" style="background:#8b5cf6;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:1rem;cursor:pointer">Confirmar baja</button></form>` : ''}
</div></body></html>`;

const invalid = (res, json) =>
  json
    ? res.status(400).json({ error: 'enlace no válido' })
    : res.status(400).send(page('Enlace no válido', 'Este enlace no es válido o ha caducado.'));

/** GET: solo muestra la confirmación. */
export const unsubscribePage = (req, res) => {
  if (!verifyUnsubscribeToken(req.params.token)) return invalid(res, false);
  return res.status(200).send(
    page(
      '¿Quieres darte de baja?',
      'Dejarás de recibir los correos de novedades de STL Gratis. Seguirás recibiendo los de tu cuenta, como la activación y la contraseña.',
      `/api/email/unsubscribe/${encodeURIComponent(req.params.token)}`
    )
  );
};

/** POST: da de baja. Responde HTML si viene de la página y JSON si viene de un cliente de correo. */
export const unsubscribeOneClick = async (req, res) => {
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  const userId = verifyUnsubscribeToken(req.params.token);
  if (!userId) return invalid(res, !wantsHtml);

  try {
    await emailMarketing.optOut(userId, 'UNSUBSCRIBE');
  } catch (e) {
    console.error('[unsubscribe] error:', e);
    return res.status(500).send(page('Error', 'No pudimos procesar la baja. Inténtalo de nuevo más tarde.'));
  }

  return wantsHtml
    ? res.status(200).send(page('Listo, te diste de baja', 'No volverás a recibir correos de novedades de STL Gratis.'))
    : res.status(200).json({ ok: true });
};

export default { unsubscribePage, unsubscribeOneClick };

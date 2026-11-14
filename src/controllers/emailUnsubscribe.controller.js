// Baja de correos de marketing con un clic desde el enlace del correo.
// El token va firmado (HMAC), así que no hace falta sesión.
//   GET  /api/email/unsubscribe/:token  -> página de confirmación
//   POST /api/email/unsubscribe/:token  -> baja con un clic (cabecera List-Unsubscribe-Post)

import emailMarketing from '../services/emailMarketing.service.js';
import { verifyUnsubscribeToken } from '../services/emailEngine.service.js';

const page = (title, text) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f6f8;margin:0;padding:48px 16px;text-align:center;color:#1a202c">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
<h1 style="font-size:1.3rem;margin:0 0 12px">${title}</h1>
<p style="margin:0;color:#4a5568">${text}</p>
</div></body></html>`;

async function unsubscribe(req, res, { json }) {
  const userId = verifyUnsubscribeToken(req.params.token);
  if (!userId) {
    return json
      ? res.status(400).json({ error: 'enlace no válido' })
      : res.status(400).send(page('Enlace no válido', 'Este enlace no es válido o ha caducado.'));
  }

  try {
    await emailMarketing.optOut(userId, 'UNSUBSCRIBE');
  } catch (e) {
    console.error('[unsubscribe] error:', e);
    return res.status(500).send(page('Error', 'No pudimos procesar la baja. Inténtalo de nuevo más tarde.'));
  }

  return json
    ? res.status(200).json({ ok: true })
    : res.status(200).send(page('Listo, te diste de baja', 'No volverás a recibir correos de novedades de STL Gratis.'));
}

// GET no cambia nada por sí solo en clientes que precargan enlaces; la baja se aplica igual
// porque el token es personal y la acción es inocua y reversible desde el panel.
export const unsubscribePage = (req, res) => unsubscribe(req, res, { json: false });
export const unsubscribeOneClick = (req, res) => unsubscribe(req, res, { json: true });

export default { unsubscribePage, unsubscribeOneClick };

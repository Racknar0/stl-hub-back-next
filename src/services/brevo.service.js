// Cliente mínimo de la API de Brevo (v3).
// Solo lo que necesita el panel: cuenta, plantillas y envío con plantilla.
// La clave vive en BREVO_API_KEY.

const API = 'https://api.brevo.com/v3';

const apiKey = () => process.env.BREVO_API_KEY || '';

export const isConfigured = () => Boolean(apiKey());

async function call(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  if (!isConfigured()) {
    const err = new Error('BREVO_API_KEY no está configurada');
    err.code = 'BREVO_NOT_CONFIGURED';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'api-key': apiKey(),
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      const err = new Error(data?.message || `Brevo ${res.status}`);
      err.status = res.status;
      err.details = data;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Datos de la cuenta: plan, créditos y límites. */
export const getAccount = () => call('/account');

/**
 * Plantillas de email. Brevo pagina de 50 en 50.
 * Devolvemos solo lo que el panel necesita pintar.
 */
export async function listTemplates({ limit = 50, offset = 0 } = {}) {
  const data = await call(`/smtp/templates?limit=${limit}&offset=${offset}&sort=desc`);
  const items = (data?.templates || []).map((t) => ({
    id: t.id,
    name: t.name,
    subject: t.subject,
    isActive: Boolean(t.isActive),
    createdAt: t.createdAt,
    modifiedAt: t.modifiedAt,
  }));
  return { total: data?.count ?? items.length, items };
}

/**
 * Envía un correo usando una plantilla de Brevo.
 * `params` alimenta las variables de la plantilla.
 */
export function sendTemplate({ templateId, to, params = {}, tags = [], headers = {} }) {
  const recipients = (Array.isArray(to) ? to : [to]).map((r) =>
    typeof r === 'string' ? { email: r } : r
  );

  return call('/smtp/email', {
    method: 'POST',
    body: {
      templateId: Number(templateId),
      to: recipients,
      ...(Object.keys(params).length ? { params } : {}),
      ...(tags.length ? { tags } : {}),
      // Cabeceras extra del correo (p. ej. List-Unsubscribe).
      ...(Object.keys(headers).length ? { headers } : {}),
    },
  });
}

/** Estadísticas agregadas de envío en un rango (YYYY-MM-DD). */
export function getEmailStats({ startDate, endDate, tag } = {}) {
  const qs = new URLSearchParams();
  if (startDate) qs.set('startDate', startDate);
  if (endDate) qs.set('endDate', endDate);
  if (tag) qs.set('tag', tag);
  const q = qs.toString();
  return call(`/smtp/statistics/aggregatedReport${q ? `?${q}` : ''}`);
}

export default {
  isConfigured,
  getAccount,
  listTemplates,
  sendTemplate,
  getEmailStats,
};

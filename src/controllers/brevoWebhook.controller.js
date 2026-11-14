// Webhook de Brevo: aperturas, clics, rebotes y bajas en tiempo real.
//
// Brevo no firma sus llamadas, así que la única protección es un secreto
// en la URL (BREVO_WEBHOOK_SECRET). Sin él, cualquiera podría inventarse
// eventos y ensuciar las audiencias.
//
// Configurar en Brevo → Transaccional → Email → Webhook:
//   https://<dominio>/api/webhooks/brevo?secret=<BREVO_WEBHOOK_SECRET>

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// evento de Brevo => qué significa para nosotros
const EVENT_MAP = {
  delivered: { logField: 'deliveredAt' },
  opened: { logField: 'openedAt', contactField: 'lastOpenAt' },
  unique_opened: { logField: 'openedAt', contactField: 'lastOpenAt' },
  click: { logField: 'clickedAt', contactField: 'lastClickAt' },
  clicks: { logField: 'clickedAt', contactField: 'lastClickAt' },
  hard_bounce: { logField: 'bouncedAt', contactField: 'lastBounceAt', optOut: 'HARD_BOUNCE' },
  blocked: { logField: 'bouncedAt', contactField: 'lastBounceAt', optOut: 'HARD_BOUNCE' },
  invalid_email: { logField: 'bouncedAt', contactField: 'lastBounceAt', optOut: 'HARD_BOUNCE' },
  soft_bounce: { logField: 'bouncedAt', contactField: 'lastBounceAt' },
  spam: { optOut: 'SPAM_COMPLAINT' },
  unsubscribed: { optOut: 'UNSUBSCRIBE' },
  list_addition: {},
  request: {},
  deferred: {},
};

const parseDate = (payload) => {
  const raw = payload?.date || payload?.ts_event || payload?.ts;
  if (!raw) return new Date();
  if (typeof raw === 'number') return new Date(raw * 1000);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

export const handleBrevoWebhook = async (req, res) => {
  // 1. Secreto
  const expected = process.env.BREVO_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[brevo-webhook] BREVO_WEBHOOK_SECRET no está configurado');
    return res.status(503).json({ error: 'webhook no configurado' });
  }
  const given = req.query.secret || req.headers['x-webhook-secret'];
  if (given !== expected) {
    return res.status(401).json({ error: 'no autorizado' });
  }

  // Brevo reintenta si no respondemos rápido: confirmamos y seguimos por detrás.
  res.status(200).json({ ok: true });

  try {
    const payload = req.body || {};
    const event = String(payload.event || '').toLowerCase();
    const email = String(payload.email || '').toLowerCase().trim();
    const occurredAt = parseDate(payload);
    const messageId = payload['message-id'] || payload.messageId || null;

    if (!event || !email) return;

    // 2. Auditoría: guardamos siempre el evento crudo
    await prisma.emailEvent.create({
      data: {
        event: event.slice(0, 40),
        email: email.slice(0, 191),
        messageId: messageId ? String(messageId).slice(0, 255) : null,
        payload: JSON.stringify(payload).slice(0, 65000),
        occurredAt,
      },
    });

    const mapping = EVENT_MAP[event];
    if (!mapping) return; // evento que no nos interesa

    // 3. ¿Tenemos a ese usuario?
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return; // contacto que no está en nuestra base

    // 4. Estado del contacto
    const contactData = {};
    if (mapping.contactField) contactData[mapping.contactField] = occurredAt;

    if (mapping.optOut) {
      contactData.stage = 'OPTED_OUT';
      contactData.optedOutAt = occurredAt;
      contactData.optOutReason = mapping.optOut;
      contactData.stageUpdatedAt = occurredAt;
    } else if (mapping.contactField === 'lastOpenAt' || mapping.contactField === 'lastClickAt') {
      // Una señal de vida lo devuelve a activo, salvo que se haya dado de baja.
      const current = await prisma.emailContact.findUnique({
        where: { userId: user.id },
        select: { optedOutAt: true, reengagedAt: true },
      });
      if (!current?.optedOutAt) {
        contactData.stage = 'ACTIVE';
        contactData.stageUpdatedAt = occurredAt;
      }
      // Si venía del reenganche, dejamos constancia de que reaccionó.
      if (current?.reengagedAt) contactData.reengagedOpen = true;
    }

    const contact = await prisma.emailContact.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...contactData },
      update: contactData,
      select: { id: true },
    });

    // 5. Envío concreto, si podemos identificarlo
    if (mapping.logField && messageId) {
      await prisma.emailLog.updateMany({
        where: { contactId: contact.id, messageId: String(messageId) },
        data: { [mapping.logField]: occurredAt },
      });
    }
  } catch (e) {
    // Ya respondimos 200: aquí solo registramos para no perder el fallo.
    console.error('[brevo-webhook] error procesando evento:', e);
  }
};

export default { handleBrevoWebhook };

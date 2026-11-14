// Email marketing: cálculo de audiencias y métricas.
//
// La etapa de cada contacto no se guarda a mano: se deduce de señales reales.
// Las de la web (login, descarga, compra) son fiables; las del correo (apertura)
// no lo son tanto, porque fallan si el lector bloquea imágenes y se disparan
// solas en Apple Mail. Por eso un contacto solo cuenta como dormido si no dio
// NINGUNA señal, ni de correo ni de web.

import { PrismaClient } from '@prisma/client';
import { getQueueSummary } from './emailEngine.service.js';

const prisma = new PrismaClient();

// ─── Ventanas (días) ──────────────────────────────────────────
// Se pueden sobrescribir por entorno sin tocar código.
export const WINDOWS = {
  // Sin ninguna señal durante este tiempo => dormido
  ACTIVE_DAYS: Number(process.env.EMAIL_ACTIVE_DAYS || 60),
  // Recién llegado: aún está recorriendo el embudo de bienvenida
  NEW_DAYS: Number(process.env.EMAIL_NEW_DAYS || 15),
  // Margen antes de considerar dormido a alguien que nunca dio señales
  DORMANT_MIN_AGE_DAYS: Number(process.env.EMAIL_DORMANT_MIN_AGE_DAYS || 45),
  // Días para reaccionar al reenganche antes de salir del marketing
  REENGAGE_GRACE_DAYS: Number(process.env.EMAIL_REENGAGE_GRACE_DAYS || 10),
};

export const STAGES = ['NEW', 'ACTIVE', 'DORMANT', 'OPTED_OUT'];

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * Última descarga por usuario. Se consulta aparte porque DownloadHistory
 * no tiene FK contra user (solo guarda el id).
 */
async function lastDownloadByUser(userIds) {
  if (!userIds?.length) return new Map();
  const rows = await prisma.downloadHistory.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
    _max: { downloadedAt: true },
  });
  return new Map(rows.map((r) => [r.userId, r._max.downloadedAt]));
}

/** Ids de usuarios con suscripción vigente. */
async function activeSubscriberIds(userIds) {
  if (!userIds?.length) return new Set();
  const rows = await prisma.subscription.findMany({
    where: {
      userId: { in: userIds },
      status: 'ACTIVE',
      currentPeriodEnd: { gt: new Date() },
    },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/** La señal más reciente de un contacto, venga de donde venga. */
export function lastSignalAt({ lastLogin, lastDownload, lastOpenAt, lastClickAt }) {
  const candidates = [lastLogin, lastDownload, lastOpenAt, lastClickAt]
    .filter(Boolean)
    .map((d) => new Date(d).getTime());
  return candidates.length ? new Date(Math.max(...candidates)) : null;
}

/**
 * Decide la etapa. El orden importa:
 *  1. Si salió del marketing, ahí se queda hasta que alguien lo reactive a mano.
 *  2. Cualquier señal reciente lo vuelve activo, aunque sea viejo.
 *  3. Recién registrado => nuevo (está recibiendo el embudo).
 *  4. Lleva tiempo y no dio señales => dormido.
 *  5. En medio (entre NEW_DAYS y DORMANT_MIN_AGE_DAYS) sigue como nuevo:
 *     acaba de terminar el embudo y merece un margen antes de molestarlo.
 */
export function computeStage(contact) {
  const { createdAt, optedOutAt } = contact;

  if (optedOutAt) return 'OPTED_OUT';

  const signal = lastSignalAt(contact);
  if (signal && signal >= daysAgo(WINDOWS.ACTIVE_DAYS)) return 'ACTIVE';

  const created = new Date(createdAt);
  if (created >= daysAgo(WINDOWS.NEW_DAYS)) return 'NEW';
  if (created < daysAgo(WINDOWS.DORMANT_MIN_AGE_DAYS)) return 'DORMANT';

  return 'NEW';
}

/**
 * Carga a todos los usuarios con sus señales y les calcula la etapa.
 * Con el volumen actual (cientos de usuarios) una sola pasada es suficiente.
 */
export async function buildContactSnapshot({ onlyUserIds = null } = {}) {
  const where = { roleId: { not: 2 } }; // fuera los admins
  if (onlyUserIds) where.id = { in: onlyUserIds };

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      language: true,
      isActive: true,
      lastLogin: true,
      createdAt: true,
      emailContact: {
        select: {
          id: true,
          stage: true,
          lastSentAt: true,
          lastOpenAt: true,
          lastClickAt: true,
          reengagedAt: true,
          reengagedOpen: true,
          optedOutAt: true,
          optOutReason: true,
        },
      },
    },
  });

  const ids = users.map((u) => u.id);
  const [downloads, premium] = await Promise.all([
    lastDownloadByUser(ids),
    activeSubscriberIds(ids),
  ]);

  return users.map((u) => {
    const c = u.emailContact || {};
    const row = {
      userId: u.id,
      email: u.email,
      language: u.language,
      isActive: u.isActive,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      lastDownload: downloads.get(u.id) || null,
      lastSentAt: c.lastSentAt || null,
      lastOpenAt: c.lastOpenAt || null,
      lastClickAt: c.lastClickAt || null,
      reengagedAt: c.reengagedAt || null,
      reengagedOpen: Boolean(c.reengagedOpen),
      optedOutAt: c.optedOutAt || null,
      optOutReason: c.optOutReason || null,
      isPremium: premium.has(u.id),
      contactId: c.id || null,
    };
    row.stage = computeStage(row);
    row.lastSignal = lastSignalAt(row);
    return row;
  });
}

/** Conteo por etapa + premium y bajas, para la pantalla de audiencias. */
export async function getAudienceCounts() {
  const snapshot = await buildContactSnapshot();

  const counts = { NEW: 0, ACTIVE: 0, DORMANT: 0, OPTED_OUT: 0 };
  let premium = 0;

  for (const c of snapshot) {
    counts[c.stage] += 1;
    if (c.isPremium) premium += 1;
  }

  return {
    total: snapshot.length,
    stages: counts,
    premium,
    windows: WINDOWS,
  };
}

/** Listado paginado de una audiencia concreta. */
export async function listAudience(stage, { page = 1, pageSize = 50 } = {}) {
  const snapshot = await buildContactSnapshot();
  const filtered = stage && stage !== 'ALL' ? snapshot.filter((c) => c.stage === stage) : snapshot;

  filtered.sort((a, b) => {
    const at = a.lastSignal ? a.lastSignal.getTime() : 0;
    const bt = b.lastSignal ? b.lastSignal.getTime() : 0;
    return bt - at;
  });

  const start = (page - 1) * pageSize;
  return {
    total: filtered.length,
    page,
    pageSize,
    items: filtered.slice(start, start + pageSize),
  };
}

/**
 * Métricas del resumen. Las de envío salen de EmailLog, que solo se llena
 * cuando el envío pasa por nosotros; lo enviado desde el panel de Brevo
 * no aparece aquí hasta que llegue su webhook.
 */
export async function getOverview() {
  const since30 = daysAgo(30);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [audience, sentToday, logs30, optOuts30, spam30, queue] = await Promise.all([
    getAudienceCounts(),
    prisma.emailLog.count({ where: { status: 'SENT', sentAt: { gte: startOfDay } } }),
    prisma.emailLog.findMany({
      where: { status: 'SENT', sentAt: { gte: since30 } },
      select: { openedAt: true, clickedAt: true, bouncedAt: true },
    }),
    prisma.emailContact.count({
      where: { optedOutAt: { gte: since30 }, optOutReason: 'UNSUBSCRIBE' },
    }),
    prisma.emailContact.count({
      where: { optedOutAt: { gte: since30 }, optOutReason: 'SPAM_COMPLAINT' },
    }),
    getQueueSummary(),
  ]);

  const sent30 = logs30.length;
  const opened = logs30.filter((l) => l.openedAt).length;
  const clicked = logs30.filter((l) => l.clickedAt).length;
  const bounced = logs30.filter((l) => l.bouncedAt).length;

  const rate = (part) => (sent30 > 0 ? Number(((part / sent30) * 100).toFixed(1)) : 0);

  return {
    contacts: audience.total,
    stages: audience.stages,
    premium: audience.premium,
    windows: audience.windows,
    // Cola del motor propio: correos programados que aún no salen.
    queue: {
      queued: queue.queued,
      failed: queue.failed,
      nextAt: queue.nextAt,
      engineEnabled: queue.engineEnabled,
    },
    daily: {
      sentToday,
      limit: Number(process.env.EMAIL_DAILY_LIMIT || 300),
    },
    last30: {
      sent: sent30,
      openRate: rate(opened),
      clickRate: rate(clicked),
      bounceRate: rate(bounced),
      unsubscribes: optOuts30,
      spamComplaints: spam30,
    },
  };
}

/**
 * Guarda la etapa calculada en EmailContact. Pensado para un cron diario:
 * mantiene la tabla al día para poder filtrar por etapa desde SQL.
 */
export async function syncStages() {
  const snapshot = await buildContactSnapshot();
  let created = 0;
  let updated = 0;

  for (const c of snapshot) {
    if (!c.contactId) {
      await prisma.emailContact.create({
        data: { userId: c.userId, stage: c.stage, stageUpdatedAt: new Date() },
      });
      created += 1;
      continue;
    }

    const current = await prisma.emailContact.findUnique({
      where: { id: c.contactId },
      select: { stage: true },
    });

    if (current?.stage !== c.stage) {
      await prisma.emailContact.update({
        where: { id: c.contactId },
        data: { stage: c.stage, stageUpdatedAt: new Date() },
      });
      updated += 1;
    }
  }

  return { total: snapshot.length, created, updated };
}

/** Saca a un contacto del marketing. No borra nada: su cuenta sigue intacta. */
export async function optOut(userId, reason = 'MANUAL') {
  const existing = await prisma.emailContact.findUnique({ where: { userId } });
  const data = {
    stage: 'OPTED_OUT',
    optedOutAt: new Date(),
    optOutReason: reason,
    stageUpdatedAt: new Date(),
  };

  if (existing) {
    return prisma.emailContact.update({ where: { userId }, data });
  }
  return prisma.emailContact.create({ data: { userId, ...data } });
}

/** Lo devuelve al marketing (por ejemplo si reaccionó al reenganche). */
export async function optIn(userId) {
  const existing = await prisma.emailContact.findUnique({ where: { userId } });
  if (!existing) return prisma.emailContact.create({ data: { userId, stage: 'NEW' } });

  return prisma.emailContact.update({
    where: { userId },
    data: {
      stage: 'ACTIVE',
      optedOutAt: null,
      optOutReason: null,
      stageUpdatedAt: new Date(),
    },
  });
}

export default {
  WINDOWS,
  STAGES,
  computeStage,
  lastSignalAt,
  buildContactSnapshot,
  getAudienceCounts,
  listAudience,
  getOverview,
  syncStages,
  optOut,
  optIn,
};

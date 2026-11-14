// Reenganche de dormidos: un correo para recuperar a quien lleva tiempo sin dar señales.
//
// Flujo:
//   1. El admin lanza una tanda desde el panel (p. ej. 100, luego 200, luego el resto).
//   2. Cada contacto de la tanda entra a la cola del motor con su hora de envío.
//   3. Pasados EMAIL_REENGAGE_GRACE_DAYS días desde el envío:
//        - si dio alguna señal (abrió, hizo clic, entró o descargó) ya es ACTIVO y no se toca;
//        - si sigue dormido, sale del marketing (NO_RESPONSE). No se borra nada.
//
// Las tandas son manuales a propósito: el dominio es nuevo y soltar todo de golpe es la forma
// más rápida de acabar en spam. Se empieza por los más recientes, que son los que más responden.

import { PrismaClient } from '@prisma/client';
import emailMarketing, { WINDOWS } from './emailMarketing.service.js';
import { REENGAGE_STEP, loadConfig } from './emailEngine.service.js';
import { clampToSendWindow, timezoneForCountry } from '../utils/emailSchedule.js';

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_BATCH = 500;

// ---------------------------------------------------------------- Funciones puras

/** A quién se le puede mandar el reenganche: dormidos activos, sin baja, no Premium y sin envío previo. */
export function isReengageCandidate(contact, alreadyQueued = new Set()) {
  return (
    contact.stage === 'DORMANT' &&
    contact.isActive &&
    !contact.optedOutAt &&
    !contact.isPremium &&
    !contact.reengagedAt &&
    !alreadyQueued.has(contact.userId)
  );
}

/** Los candidatos más recientes primero (los sin señal al final) y recortados a la tanda. */
export function pickBatch(snapshot, { alreadyQueued = new Set(), batchSize }) {
  const time = (c) => (c.lastSignal ? new Date(c.lastSignal).getTime() : 0);
  return snapshot
    .filter((c) => isReengageCandidate(c, alreadyQueued))
    .sort((a, b) => time(b) - time(a) || a.userId - b.userId)
    .slice(0, batchSize);
}

/** ¿Venció el plazo sin reacción? `stage` es la etapa calculada hoy. */
export function shouldCloseReengage({ reengagedAt, optedOutAt, stage }, now, graceDays) {
  if (!reengagedAt || optedOutAt) return false;
  if (now.getTime() - new Date(reengagedAt).getTime() < graceDays * DAY_MS) return false;
  return stage === 'DORMANT';
}

// ---------------------------------------------------------------- Operaciones

async function queuedUserIds() {
  const rows = await prisma.emailLog.findMany({
    where: { kind: 'REENGAGE' },
    select: { contact: { select: { userId: true } } },
  });
  return new Set(rows.map((r) => r.contact.userId));
}

/** Estado del reenganche para el panel. */
export async function getReengageSummary() {
  const [snapshot, logs, queued] = await Promise.all([
    emailMarketing.buildContactSnapshot(),
    prisma.emailLog.groupBy({ by: ['status'], where: { kind: 'REENGAGE' }, _count: { _all: true } }),
    queuedUserIds(),
  ]);

  const count = (status) => logs.find((l) => l.status === status)?._count._all || 0;
  const reached = snapshot.filter((c) => c.reengagedAt);

  return {
    dormant: snapshot.filter((c) => c.stage === 'DORMANT').length,
    available: snapshot.filter((c) => isReengageCandidate(c, queued)).length,
    queued: count('QUEUED'),
    sent: count('SENT'),
    failed: count('FAILED'),
    reacted: reached.filter((c) => c.stage === 'ACTIVE').length,
    waiting: reached.filter((c) => c.stage === 'DORMANT' && !c.optedOutAt).length,
    closed: reached.filter((c) => c.optedOutAt && c.optOutReason === 'NO_RESPONSE').length,
    graceDays: WINDOWS.REENGAGE_GRACE_DAYS,
    maxBatch: MAX_BATCH,
  };
}

/** Pone en cola una tanda de reenganche. Los envíos salen al ritmo y cupo del motor. */
export async function launchReengageBatch({ batchSize, now = new Date() }) {
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) {
    return { error: `La tanda debe ser un entero entre 1 y ${MAX_BATCH}` };
  }

  const cfg = await loadConfig();
  const snapshot = await emailMarketing.buildContactSnapshot();
  const batch = pickBatch(snapshot, { alreadyQueued: await queuedUserIds(), batchSize: size });
  if (batch.length === 0) return { queued: 0, engineEnabled: cfg.enabled };

  const countries = await prisma.user.findMany({
    where: { id: { in: batch.map((c) => c.userId) } },
    select: { id: true, registerCountry: true },
  });
  const countryOf = new Map(countries.map((u) => [u.id, u.registerCountry]));

  let queued = 0;
  for (const c of batch) {
    const contact = await prisma.emailContact.upsert({
      where: { userId: c.userId },
      create: { userId: c.userId, stage: 'DORMANT' },
      update: {},
      select: { id: true },
    });

    const scheduledFor = clampToSendWindow(now, timezoneForCountry(countryOf.get(c.userId)), cfg.window);
    const res = await prisma.emailLog.createMany({
      data: [
        {
          contactId: contact.id,
          kind: REENGAGE_STEP.kind,
          templateId: REENGAGE_STEP.templateId,
          status: 'QUEUED',
          scheduledFor,
          dedupeKey: `${REENGAGE_STEP.kind}:${c.userId}`,
        },
      ],
      skipDuplicates: true,
    });
    queued += res.count;
  }

  return { queued, engineEnabled: cfg.enabled };
}

/** Saca del marketing a quien no reaccionó dentro del plazo. */
export async function closeExpiredReengage(now = new Date()) {
  const limit = new Date(now.getTime() - WINDOWS.REENGAGE_GRACE_DAYS * DAY_MS);
  const due = await prisma.emailContact.findMany({
    where: { reengagedAt: { lte: limit }, optedOutAt: null },
    select: { userId: true },
  });
  if (due.length === 0) return { closed: 0 };

  const snapshot = await emailMarketing.buildContactSnapshot({ onlyUserIds: due.map((d) => d.userId) });
  let closed = 0;
  for (const c of snapshot) {
    if (shouldCloseReengage(c, now, WINDOWS.REENGAGE_GRACE_DAYS)) {
      await emailMarketing.optOut(c.userId, 'NO_RESPONSE');
      closed += 1;
    }
  }
  return { closed };
}

let timer = null;

/** Revisa cada 6 horas quién agotó su plazo. Solo toca a quienes ya recibieron el reenganche. */
export function startReengageCloser(intervalMs = 6 * 60 * 60 * 1000) {
  if (timer) return;
  const run = async () => {
    try {
      const out = await closeExpiredReengage();
      if (out.closed) console.log('[reengage]', JSON.stringify(out));
    } catch (e) {
      console.error('[reengage] error:', e?.message || e);
    }
  };
  setTimeout(run, 2 * 60 * 1000);
  timer = setInterval(run, intervalMs);
}

export default {
  MAX_BATCH,
  isReengageCandidate,
  pickBatch,
  shouldCloseReengage,
  getReengageSummary,
  launchReengageBatch,
  closeExpiredReengage,
  startReengageCloser,
};

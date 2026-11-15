// Motor de envíos propio: cola con cupo diario y embudo de bienvenida.
//
// Cada pocos minutos hace dos cosas:
//   1. Planificar: para cada usuario reciente crea sus 4 correos del embudo en `emaillog`
//      (estado QUEUED o SKIPPED) con la hora a la que deben salir.
//   2. Enviar: manda los vencidos por orden, sin pasar del cupo diario.
//
// Nace APAGADO. Con EMAIL_ENGINE_ENABLED distinto de "true" solo planifica (se ve en el panel)
// y no envía nada. Sin EMAIL_ENGINE_START no hace nada: esa fecha es el corte que evita
// repetir correos que ya salieron por Brevo.

import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import brevo from './brevo.service.js';
import newsletter, { NEWSLETTER_STEP, NEWSLETTER_MIN_MODELS } from './emailNewsletter.service.js';
import campaignsSvc from './emailCampaigns.service.js';
import { scheduleStep, zonedParts, clampToSendWindow, timezoneForCountry } from '../utils/emailSchedule.js';

const prisma = new PrismaClient();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Pasos del embudo de bienvenida. `sales` = correo de venta de Premium: no se envía a quien ya lo es.
export const FUNNEL = [
  { kind: 'WELCOME_1', templateId: 15, delayHours: 1, sales: false },
  { kind: 'WELCOME_2', templateId: 16, delayDays: 3, sales: true },
  { kind: 'WELCOME_3', templateId: 17, delayDays: 7, sales: false },
  { kind: 'WELCOME_4', templateId: 18, delayDays: 12, sales: true },
];

// Ajustes editables desde el panel (tabla SystemSetting). Mandan sobre las variables de entorno.
export const SETTING_KEYS = {
  enabled: 'EMAIL_ENGINE_ENABLED',
  start: 'EMAIL_ENGINE_START',
  dailyLimit: 'EMAIL_DAILY_LIMIT',
  dailyReserve: 'EMAIL_DAILY_RESERVE',
  newsletter: 'EMAIL_NEWSLETTER_ENABLED',
};

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Configuración final: ajuste del panel si existe; si no, variable de entorno; si no, valor por defecto. */
export function buildConfig(env = process.env, overrides = {}) {
  const pick = (key) => (overrides[key] !== undefined && overrides[key] !== '' ? overrides[key] : env[key]);
  return {
    enabled: pick(SETTING_KEYS.enabled) === 'true',
    // Novedades semanales: apagadas hasta que se encienden desde el panel.
    newsletterEnabled: pick(SETTING_KEYS.newsletter) === 'true',
    start: toDate(pick(SETTING_KEYS.start)),
    dailyLimit: Number(pick(SETTING_KEYS.dailyLimit) || 300),
    // Cupo que se deja libre para los correos de activación y contraseña, que cuentan igual.
    dailyReserve: Number(pick(SETTING_KEYS.dailyReserve) || 50),
    window: {
      startHour: Number(env.EMAIL_SEND_START_HOUR || 9),
      endHour: Number(env.EMAIL_SEND_END_HOUR || 20),
    },
    // Un paso atrasado más de estas horas se descarta en vez de enviarse tarde.
    staleHours: Number(env.EMAIL_STALE_HOURS || 24),
    maxAttempts: 3,
    publicUrl: (env.EMAIL_PUBLIC_URL || 'https://stlgratis.com').replace(/\/$/, ''),
  };
}

/** Lee los ajustes guardados en la base y arma la configuración. */
export async function loadConfig() {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(SETTING_KEYS) } },
  });
  return buildConfig(process.env, Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

export const getConfig = () => buildConfig(process.env);

// Correo de reenganche (plantilla 19). No es del embudo: lo lanza el admin por tandas.
export const REENGAGE_STEP = { kind: 'REENGAGE', templateId: 19, sales: false };

// Avisos de Premium. Las suscripciones son períodos prepagados que no se renuevan solos.
//  - EXPIRING: faltan pocos días para que termine.
//  - EXPIRED: terminó hace unos días y no renovó.
export const PREMIUM_STEPS = {
  PREMIUM_EXPIRING: { kind: 'PREMIUM_EXPIRING', templateId: 22, sales: false, daysBefore: 3 },
  PREMIUM_EXPIRED: { kind: 'PREMIUM_EXPIRED', templateId: 23, sales: false, daysAfter: 2, maxAgeDays: 7 },
};

const DAY_KEY_TZ = 'America/Bogota';

/** Día (AAAA-MM-DD) en que termina un período, visto desde Colombia. Va en la clave anti-duplicados. */
export function endDayKey(date) {
  const p = zonedParts(new Date(date), DAY_KEY_TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Fecha legible del fin de período, en el idioma de la persona. */
export function formatExpiryDate(dayKey, language = 'es') {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'es-ES', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * ¿Hay que descartar un aviso de Premium justo antes de enviarlo?
 * `currentEnd` es el fin de período vigente del usuario hoy.
 */
export function premiumNoticeSkip({ kind, dedupeKey, currentEnd, now }) {
  const keyDay = String(dedupeKey || '').split(':')[2];
  const renewed = currentEnd && endDayKey(currentEnd) !== keyDay && new Date(currentEnd) > now;
  if (kind === 'PREMIUM_EXPIRING') return renewed ? 'renovó' : null;
  if (kind === 'PREMIUM_EXPIRED') return currentEnd && new Date(currentEnd) > now ? 'ya es Premium' : null;
  return null;
}

/**
 * Valida lo que llega del panel. Devuelve { values, error }.
 * `values` solo trae las claves recibidas, ya como texto listo para guardar.
 * Encender el motor exige fecha de corte y secreto de baja configurado.
 */
export function parseEngineSettings(body = {}, { current, hasSecret }) {
  const values = {};
  const next = { ...current };

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled debe ser verdadero o falso' };
    values[SETTING_KEYS.enabled] = String(body.enabled);
    next.enabled = body.enabled;
  }

  if (body.newsletterEnabled !== undefined) {
    if (typeof body.newsletterEnabled !== 'boolean') return { error: 'newsletterEnabled debe ser verdadero o falso' };
    values[SETTING_KEYS.newsletter] = String(body.newsletterEnabled);
    next.newsletterEnabled = body.newsletterEnabled;
  }

  if (body.start !== undefined) {
    if (body.start === null || body.start === '') {
      values[SETTING_KEYS.start] = '';
      next.start = null;
    } else {
      const d = toDate(body.start);
      if (!d) return { error: 'La fecha de corte no es válida' };
      values[SETTING_KEYS.start] = d.toISOString();
      next.start = d;
    }
  }

  if (body.dailyLimit !== undefined) {
    const n = Number(body.dailyLimit);
    if (!Number.isInteger(n) || n < 1 || n > 2000) return { error: 'El límite diario debe ser un entero entre 1 y 2000' };
    values[SETTING_KEYS.dailyLimit] = String(n);
    next.dailyLimit = n;
  }

  if (body.dailyReserve !== undefined) {
    const n = Number(body.dailyReserve);
    if (!Number.isInteger(n) || n < 0) return { error: 'La reserva debe ser un entero de 0 en adelante' };
    values[SETTING_KEYS.dailyReserve] = String(n);
    next.dailyReserve = n;
  }

  if (next.dailyReserve >= next.dailyLimit) return { error: 'La reserva debe ser menor que el límite diario' };
  if (next.enabled && !next.start) return { error: 'Para encender el motor define antes la fecha de corte' };
  if (next.newsletterEnabled && !next.start) return { error: 'Para encender las novedades define antes la fecha de corte' };
  if (next.enabled && !hasSecret) return { error: 'Falta EMAIL_UNSUBSCRIBE_SECRET en el servidor' };

  return { values };
}

// ---------------------------------------------------------------- Funciones puras

/** Estado inicial de un paso al planificarlo. */
export function initialStatus({ scheduledFor, start, now, optedOut = false, staleHours = 24 }) {
  if (optedOut) return 'SKIPPED';
  if (scheduledFor < start) return 'SKIPPED'; // ya tocaba antes del corte: lo cubrió Brevo
  if (now.getTime() - scheduledFor.getTime() > staleHours * HOUR_MS) return 'SKIPPED'; // llegó tarde
  return 'QUEUED';
}

/** Cuántos correos caben aún hoy. */
export const remainingQuota = ({ limit, reserve = 0, sentToday }) =>
  Math.max(0, limit - reserve - sentToday);

/**
 * Desde cuándo se cuentan los envíos del cupo: las últimas 24 horas. Brevo reinicia su límite a
 * una hora propia que no controlamos; con una ventana móvil nunca se supera, sea cual sea.
 */
export const quotaWindowStart = (date = new Date()) => new Date(date.getTime() - DAY_MS);

/** Si el correo debe descartarse justo antes de enviarlo. */
export function skipReason({ step, user, contact, isPremium }) {
  if (contact?.optedOutAt) return 'baja';
  if (!user?.isActive) return 'cuenta inactiva';
  if (step?.sales && isPremium) return 'premium';
  return null;
}

// ---------------------------------------------------------------- Baja (desuscripción)

const unsubscribeSecret = () => process.env.EMAIL_UNSUBSCRIBE_SECRET || '';

const sign = (userId) =>
  crypto.createHmac('sha256', unsubscribeSecret()).update(String(userId)).digest('base64url').slice(0, 32);

/** Token firmado para el enlace de baja de un usuario. */
export const buildUnsubscribeToken = (userId) => `${userId}.${sign(userId)}`;

/** Devuelve el userId si el token es válido; si no, null. */
export function verifyUnsubscribeToken(token) {
  if (!unsubscribeSecret()) return null;
  const [id, signature] = String(token || '').split('.');
  const userId = Number(id);
  if (!Number.isInteger(userId) || !signature) return null;

  const expected = Buffer.from(sign(userId));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return null;
  return crypto.timingSafeEqual(expected, received) ? userId : null;
}

export const buildUnsubscribeUrl = (userId, publicUrl = getConfig().publicUrl) =>
  `${publicUrl}/api/email/unsubscribe/${buildUnsubscribeToken(userId)}`;

// ---------------------------------------------------------------- Planificación

/** Crea en `emaillog` los correos del embudo de quienes se registraron hace poco. */
export async function planFunnel(now = new Date()) {
  const cfg = await loadConfig();
  if (!cfg.start) return { planned: 0, skipped: 0, reason: 'EMAIL_ENGINE_START no configurado' };

  // Quien se registró antes de (corte - 14 días) ya tenía todos sus pasos vencidos antes del corte.
  const since = new Date(cfg.start.getTime() - 14 * DAY_MS);

  const users = await prisma.user.findMany({
    where: { isActive: true, roleId: { not: 2 }, createdAt: { gte: since } },
    select: {
      id: true,
      createdAt: true,
      registerCountry: true,
      emailContact: { select: { id: true, optedOutAt: true } },
    },
  });

  let planned = 0;
  let skipped = 0;

  for (const user of users) {
    const contact =
      user.emailContact ||
      (await prisma.emailContact.upsert({
        where: { userId: user.id },
        create: { userId: user.id, stage: 'NEW' },
        update: {},
        select: { id: true, optedOutAt: true },
      }));

    const rows = FUNNEL.map((step) => {
      const scheduledFor = scheduleStep({
        createdAt: user.createdAt,
        country: user.registerCountry,
        step,
        window: cfg.window,
      });
      const status = initialStatus({
        scheduledFor,
        start: cfg.start,
        now,
        optedOut: Boolean(contact.optedOutAt),
        staleHours: cfg.staleHours,
      });
      return {
        contactId: contact.id,
        kind: step.kind,
        templateId: step.templateId,
        status,
        scheduledFor,
        dedupeKey: `${step.kind}:${user.id}`,
      };
    });

    const result = await prisma.emailLog.createMany({ data: rows, skipDuplicates: true });
    planned += result.count;
    skipped += rows.filter((r) => r.status === 'SKIPPED').length;
  }

  return { planned, skipped, users: users.length };
}

/** Último fin de período por usuario (un usuario puede tener más de una fila). */
async function latestEndByUser(where) {
  const subs = await prisma.subscription.findMany({ where, select: { userId: true, currentPeriodEnd: true } });
  const map = new Map();
  for (const s of subs) {
    const prev = map.get(s.userId);
    if (!prev || s.currentPeriodEnd > prev) map.set(s.userId, s.currentPeriodEnd);
  }
  return map;
}

/**
 * Programa los avisos de Premium: uno cuando faltan pocos días para vencer y otro unos días
 * después de vencer. La clave incluye el día de fin de período: si renueva, el siguiente
 * período genera avisos nuevos, y el mismo período nunca recibe dos veces el mismo aviso.
 */
export async function planPremiumNotices(now = new Date()) {
  const cfg = await loadConfig();
  if (!cfg.start) return { planned: 0, reason: 'EMAIL_ENGINE_START no configurado' };

  const exp = PREMIUM_STEPS.PREMIUM_EXPIRING;
  const gone = PREMIUM_STEPS.PREMIUM_EXPIRED;
  const rows = [];

  const candidates = await prisma.subscription.findMany({
    where: {
      currentPeriodEnd: {
        gt: new Date(now.getTime() - gone.maxAgeDays * DAY_MS),
        lte: new Date(now.getTime() + (exp.daysBefore + 1) * DAY_MS),
      },
    },
    select: {
      userId: true,
      currentPeriodEnd: true,
      user: {
        select: {
          isActive: true,
          roleId: true,
          registerCountry: true,
          emailContact: { select: { id: true, optedOutAt: true } },
        },
      },
    },
  });

  // Solo cuenta el período más reciente de cada usuario.
  const latest = new Map();
  for (const s of candidates) {
    const prev = latest.get(s.userId);
    if (!prev || s.currentPeriodEnd > prev.currentPeriodEnd) latest.set(s.userId, s);
  }
  const newest = await latestEndByUser({ userId: { in: [...latest.keys()] } });

  for (const s of latest.values()) {
    if (!s.user.isActive || s.user.roleId === 2) continue;
    if (s.currentPeriodEnd.getTime() !== newest.get(s.userId)?.getTime()) continue; // ya hay uno posterior

    const end = s.currentPeriodEnd;
    const tz = timezoneForCountry(s.user.registerCountry);
    const step = end > now ? exp : gone;
    const base = end > now ? end.getTime() - exp.daysBefore * DAY_MS : end.getTime() + gone.daysAfter * DAY_MS;
    const scheduledFor = clampToSendWindow(new Date(Math.max(base, now.getTime())), tz, cfg.window);

    const contact =
      s.user.emailContact ||
      (await prisma.emailContact.upsert({
        where: { userId: s.userId },
        create: { userId: s.userId, stage: 'ACTIVE' },
        update: {},
        select: { id: true, optedOutAt: true },
      }));

    rows.push({
      contactId: contact.id,
      kind: step.kind,
      templateId: step.templateId,
      status: contact.optedOutAt ? 'SKIPPED' : 'QUEUED',
      scheduledFor,
      dedupeKey: `${step.kind}:${s.userId}:${endDayKey(end)}`,
    });
  }

  const result = rows.length ? await prisma.emailLog.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  return { planned: result.count };
}

// ---------------------------------------------------------------- Envío

const tagOf = (kind) =>
  kind === 'REENGAGE' ? 'reengage' : kind === NEWSLETTER_STEP.kind ? 'newsletter' : PREMIUM_STEPS[kind] ? 'premium' : 'funnel';

const stepOf = (kind) =>
  [...FUNNEL, REENGAGE_STEP, ...Object.values(PREMIUM_STEPS), NEWSLETTER_STEP].find((s) => s.kind === kind);

/** Envía los correos vencidos respetando el cupo diario. */
export async function sendDue(now = new Date()) {
  const cfg = await loadConfig();

  const sentToday = await prisma.emailLog.count({
    where: { status: 'SENT', sentAt: { gte: quotaWindowStart(now) } },
  });
  const quota = remainingQuota({ limit: cfg.dailyLimit, reserve: cfg.dailyReserve, sentToday });

  const due = await prisma.emailLog.findMany({
    where: { status: 'QUEUED', scheduledFor: { lte: now } },
    orderBy: { scheduledFor: 'asc' },
    take: quota,
    include: {
      contact: {
        select: {
          id: true,
          optedOutAt: true,
          user: { select: { id: true, email: true, language: true, isActive: true } },
        },
      },
    },
  });

  if (!cfg.enabled) {
    return { dryRun: true, wouldSend: due.length, quota, sentToday };
  }
  if (!brevo.isConfigured()) return { error: 'BREVO_API_KEY no configurada', sent: 0 };
  if (!process.env.EMAIL_UNSUBSCRIBE_SECRET) {
    return { error: 'EMAIL_UNSUBSCRIBE_SECRET no configurada', sent: 0 };
  }

  const premiumRows = due.length
    ? await prisma.subscription.findMany({
        where: {
          userId: { in: due.map((d) => d.contact.user.id) },
          status: 'ACTIVE',
          currentPeriodEnd: { gt: now },
        },
        select: { userId: true },
      })
    : [];
  const premium = new Set(premiumRows.map((r) => r.userId));

  // Para los avisos de Premium se comprueba el fin de período vigente justo antes de enviar.
  const noticeUserIds = due.filter((d) => PREMIUM_STEPS[d.kind]).map((d) => d.contact.user.id);
  const endByUser = noticeUserIds.length
    ? await latestEndByUser({ userId: { in: noticeUserIds } })
    : new Map();

  // Novedades: los modelos recientes se leen una vez por vuelta y se reparten por usuario.
  const newsletterDue = due.filter((d) => d.kind === NEWSLETTER_STEP.kind);
  const freshAssets = newsletterDue.length ? await newsletter.loadTopAssets(now) : [];
  const downloadedBy = newsletterDue.length
    ? await newsletter.loadDownloadedByUser(
        newsletterDue.map((d) => d.contact.user.id),
        freshAssets
      )
    : new Map();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const log of due) {
    const { user } = log.contact;
    const step = stepOf(log.kind);

    const reason =
      skipReason({
        step,
        user,
        contact: log.contact,
        isPremium: premium.has(user.id),
      }) ||
      (PREMIUM_STEPS[log.kind]
        ? premiumNoticeSkip({
            kind: log.kind,
            dedupeKey: log.dedupeKey,
            currentEnd: endByUser.get(user.id),
            now,
          })
        : null) ||
      (log.kind === NEWSLETTER_STEP.kind ? newsletter.newsletterSkip({ scheduledFor: log.scheduledFor, now }) : null);

    const models =
      !reason && log.kind === NEWSLETTER_STEP.kind
        ? newsletter.modelsForUser({
            assets: freshAssets,
            downloaded: downloadedBy.get(user.id),
            language: user.language || 'es',
            publicUrl: cfg.publicUrl,
          })
        : null;
    const finalReason = reason || (models && models.length < NEWSLETTER_MIN_MODELS ? 'sin modelos' : null);

    if (finalReason) {
      await prisma.emailLog.update({
        where: { id: log.id },
        data: { status: 'SKIPPED', lastError: finalReason },
      });
      skipped += 1;
      continue;
    }

    const unsubscribeUrl = buildUnsubscribeUrl(user.id, cfg.publicUrl);

    try {
      const res = await brevo.sendTemplate({
        templateId: log.templateId,
        to: user.email,
        params: {
          LANGUAGE: user.language || 'es',
          UNSUBSCRIBE_URL: unsubscribeUrl,
          // Solo los avisos de Premium la usan: el día en que termina el período.
          ...(PREMIUM_STEPS[log.kind]
            ? { EXPIRY_DATE: formatExpiryDate(String(log.dedupeKey).split(':')[2], user.language || 'es') }
            : {}),
          ...(models ? { MODELS: models } : {}),
        },
        tags: String(log.dedupeKey).startsWith('CAMPAIGN:') ? ['campaign', log.dedupeKey.split(':')[1]] : [tagOf(log.kind), log.kind],
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      await prisma.$transaction([
        prisma.emailLog.update({
          where: { id: log.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            messageId: res?.messageId || null,
            attempts: { increment: 1 },
            lastError: null,
          },
        }),
        prisma.emailContact.update({
          where: { id: log.contact.id },
          data: {
            lastSentAt: new Date(),
            // Marca cuándo recibió el reenganche: de ahí corre el plazo para reaccionar.
            ...(log.kind === 'REENGAGE' ? { reengagedAt: new Date() } : {}),
          },
        }),
      ]);
      sent += 1;
    } catch (err) {
      failed += 1;
      const attempts = log.attempts + 1;
      await prisma.emailLog.update({
        where: { id: log.id },
        data: {
          attempts,
          lastError: String(err?.message || 'error').slice(0, 250),
          status: attempts >= cfg.maxAttempts ? 'FAILED' : 'QUEUED',
          // Reintento más adelante, cada vez más espaciado.
          scheduledFor: new Date(now.getTime() + attempts * 30 * 60 * 1000),
        },
      });

      // Si Brevo rechaza la cuenta o la clave, no insistir con el resto.
      if (err?.status === 401 || err?.status === 403) break;
    }
  }

  return { sent, skipped, failed, quota, sentToday };
}

/**
 * Prueba: envía un paso del embudo al correo del propio administrador, con los mismos
 * parámetros que un envío real. No usa la cola ni cuenta como envío del embudo.
 */
export async function sendTestEmail({ kind, userId }) {
  const step = stepOf(kind);
  if (!step) return { error: 'Paso del embudo desconocido' };
  if (!brevo.isConfigured()) return { error: 'BREVO_API_KEY no configurada' };
  if (!process.env.EMAIL_UNSUBSCRIBE_SECRET) return { error: 'EMAIL_UNSUBSCRIBE_SECRET no configurada' };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, language: true },
  });
  if (!user) return { error: 'Usuario no encontrado' };

  // En la prueba de novedades se usan los mismos modelos que saldrían hoy, sin filtrar por usuario.
  let models = null;
  if (step.kind === NEWSLETTER_STEP.kind) {
    const assets = await newsletter.loadTopAssets(new Date());
    models = newsletter.modelsForUser({
      assets,
      language: user.language || 'es',
      publicUrl: getConfig().publicUrl,
    });
    if (!models.length) return { error: 'No hay modelos publicados con imagen' };
  }

  const cfg = getConfig();
  const unsubscribeUrl = buildUnsubscribeUrl(user.id, cfg.publicUrl);
  const res = await brevo.sendTemplate({
    templateId: step.templateId,
    to: user.email,
    params: {
      LANGUAGE: user.language || 'es',
      UNSUBSCRIBE_URL: unsubscribeUrl,
      // En la prueba de los avisos de Premium se usa una fecha de ejemplo: dentro de 3 días.
      ...(PREMIUM_STEPS[step.kind]
        ? { EXPIRY_DATE: formatExpiryDate(endDayKey(new Date(Date.now() + 3 * DAY_MS)), user.language || 'es') }
        : {}),
      ...(models ? { MODELS: models } : {}),
    },
    tags: ['funnel-test', step.kind],
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  return { ok: true, to: user.email, messageId: res?.messageId || null };
}

/** Prueba de una campaña manual: la plantilla elegida llega al correo del admin que la pide. */
export async function sendCampaignTest({ templateId, userId }) {
  if (!Number.isInteger(templateId) || templateId < 1) return { error: 'Plantilla no válida' };
  if (!brevo.isConfigured()) return { error: 'BREVO_API_KEY no configurada' };
  if (!process.env.EMAIL_UNSUBSCRIBE_SECRET) return { error: 'EMAIL_UNSUBSCRIBE_SECRET no configurada' };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, language: true },
  });
  if (!user) return { error: 'Usuario no encontrado' };

  const unsubscribeUrl = buildUnsubscribeUrl(user.id, getConfig().publicUrl);
  const res = await brevo.sendTemplate({
    templateId,
    to: user.email,
    params: { LANGUAGE: user.language || 'es', UNSUBSCRIBE_URL: unsubscribeUrl },
    tags: ['campaign-test'],
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  return { ok: true, to: user.email, messageId: res?.messageId || null };
}

// ---------------------------------------------------------------- Estado y ciclo

/** Resumen de la cola para el panel. */
export async function getQueueSummary(now = new Date()) {
  const [queued, next, failed] = await Promise.all([
    prisma.emailLog.count({ where: { status: 'QUEUED' } }),
    prisma.emailLog.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { scheduledFor: 'asc' },
      select: { scheduledFor: true },
    }),
    prisma.emailLog.count({ where: { status: 'FAILED' } }),
  ]);
  const cfg = await loadConfig();
  return {
    queued,
    failed,
    nextAt: next?.scheduledFor || null,
    engineEnabled: cfg.enabled,
    startAt: cfg.start,
    now,
  };
}

let running = false;

/** Una vuelta completa: planificar y enviar. Nunca se solapa consigo misma. */
export async function tick() {
  if (running) return { skipped: 'ya hay una vuelta en curso' };
  running = true;
  try {
    const plan = await planFunnel();
    const premium = await planPremiumNotices();
    const cfg = await loadConfig();
    const news = await newsletter.planNewsletter(cfg);
    // Las campañas programadas se lanzan solo con el motor encendido.
    const campaigns = cfg.enabled ? await campaignsSvc.launchDue(cfg) : { launched: 0 };
    const send = await sendDue();
    return { plan, premium, news, campaigns, send };
  } finally {
    running = false;
  }
}

let timer = null;

/** Arranca el ciclo. Con el motor apagado solo planifica, no envía. */
export function startEmailEngine(intervalMs = 5 * 60 * 1000) {
  if (timer) return;

  const run = async () => {
    try {
      const out = await tick();
      const sent = out?.send?.sent ?? 0;
      const would = out?.send?.wouldSend ?? 0;
      if (out?.plan?.planned || out?.premium?.planned || out?.news?.planned || sent || would) {
        console.log('[email-engine]', JSON.stringify(out));
      }
    } catch (e) {
      console.error('[email-engine] error:', e?.message || e);
    }
  };

  setTimeout(run, 60 * 1000);
  timer = setInterval(run, intervalMs);
  console.log(`[email-engine] programado cada ${Math.round(intervalMs / 1000)} s`);
}

export default {
  FUNNEL,
  REENGAGE_STEP,
  PREMIUM_STEPS,
  planPremiumNotices,
  endDayKey,
  formatExpiryDate,
  premiumNoticeSkip,
  SETTING_KEYS,
  buildConfig,
  loadConfig,
  getConfig,
  parseEngineSettings,
  initialStatus,
  remainingQuota,
  quotaWindowStart,
  skipReason,
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  planFunnel,
  sendDue,
  sendTestEmail,
  sendCampaignTest,
  getQueueSummary,
  tick,
  startEmailEngine,
};

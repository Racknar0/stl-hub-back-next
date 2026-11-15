// Novedades semanales: un correo con los modelos más recientes para quienes están Activos.
//
// Cada semana (el día de NEWSLETTER_WEEKDAY, hora de Colombia) el motor pone en cola un correo
// por contacto Activo. El contenido se arma justo al enviar: los modelos publicados en los
// últimos días que ese usuario todavía no descargó. Si no hay modelos nuevos, no sale nada.
//
// La plantilla de Brevo (NEWSLETTER_STEP.templateId) recibe la lista en `params.MODELS`,
// cada elemento con { title, image, url }, y la repite con un bucle.

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { clampToSendWindow, timezoneForCountry, zonedParts, DEFAULT_TIMEZONE } from '../utils/emailSchedule.js';

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;

export const NEWSLETTER_STEP = { kind: 'NEWSLETTER', templateId: 24, sales: false };
// Día de envío: 2 = martes (0 = domingo), visto desde Colombia.
export const NEWSLETTER_WEEKDAY = 2;
// Cuántos modelos lleva cada correo y cuántos hacen falta como mínimo para que valga la pena.
export const NEWSLETTER_MODELS = 4;
export const NEWSLETTER_MIN_MODELS = 2;
// Se consideran novedades los modelos publicados en los últimos días.
export const NEWSLETTER_FRESH_DAYS = 8;
// Un correo en cola que lleva más de estos días sin salir ya no es una novedad: se descarta.
export const NEWSLETTER_MAX_AGE_DAYS = 3;

// ---------------------------------------------------------------- Funciones puras

/** Día de la semana (0 = domingo) en Colombia. */
export function weekdayOf(date, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Lunes (AAAA-MM-DD) de la semana de esa fecha: identifica la edición para no repetirla. */
export function weekKey(date, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(date, timeZone);
  const day = Date.UTC(p.year, p.month - 1, p.day);
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export const isNewsletterDay = (date) => weekdayOf(date) === NEWSLETTER_WEEKDAY;

/** Si el correo en cola ya no debe salir. */
export function newsletterSkip({ scheduledFor, now }) {
  if (now.getTime() - new Date(scheduledFor).getTime() > NEWSLETTER_MAX_AGE_DAYS * DAY_MS) return 'vencida';
  return null;
}

const toArray = (images) => {
  if (Array.isArray(images)) return images;
  if (typeof images === 'string') {
    try {
      const parsed = JSON.parse(images);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const normalize = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^uploads\//, '');

/** Ruta (dentro de uploads) de la miniatura de un modelo, o la imagen entera si no hay miniatura. */
export function pickImagePath(images, thumbExists = () => true) {
  const first = normalize(toArray(images)[0]);
  if (!first) return null;
  const thumb = `${path.posix.dirname(first)}/thumbs/thumb_1.webp`;
  return thumbExists(thumb) ? thumb : first;
}

/**
 * Elige los modelos de un correo: los más recientes que el usuario no descargó, en su idioma.
 * `assets` llega ordenado del más nuevo al más viejo.
 */
export function buildModels({
  assets,
  downloaded = new Set(),
  language = 'es',
  publicUrl,
  count = NEWSLETTER_MODELS,
  thumbExists,
}) {
  const en = language === 'en';
  const out = [];
  for (const a of assets) {
    if (out.length >= count) break;
    if (downloaded.has(a.id)) continue;
    const img = pickImagePath(a.images, thumbExists);
    if (!img || !a.slug) continue;
    out.push({
      title: (en && a.titleEn) || a.title,
      image: `${publicUrl}/uploads/${img}`,
      url: `${publicUrl}${en ? '/en' : ''}/asset/${a.slug}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Con base de datos

const uploadsDir = () => process.env.UPLOADS_DIR || path.resolve('uploads');
const thumbOnDisk = (rel) => fs.existsSync(path.join(uploadsDir(), rel));

/** Modelos publicados en los últimos `days` días, del más nuevo al más viejo. */
export async function loadFreshAssets(now = new Date(), days = NEWSLETTER_FRESH_DAYS) {
  return prisma.asset.findMany({
    where: { status: 'PUBLISHED', createdAt: { gte: new Date(now.getTime() - days * DAY_MS) } },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { id: true, title: true, titleEn: true, slug: true, images: true },
  });
}

/** Qué modelos de la lista ya descargó cada usuario. */
export async function loadDownloadedByUser(userIds, assets) {
  const map = new Map();
  if (!userIds.length || !assets.length) return map;
  const rows = await prisma.downloadHistory.findMany({
    where: { userId: { in: userIds }, assetId: { in: assets.map((a) => a.id) } },
    select: { userId: true, assetId: true },
  });
  for (const r of rows) {
    if (!map.has(r.userId)) map.set(r.userId, new Set());
    map.get(r.userId).add(r.assetId);
  }
  return map;
}

export const modelsForUser = ({ assets, downloaded, language, publicUrl }) =>
  buildModels({ assets, downloaded, language, publicUrl, thumbExists: thumbOnDisk });

/**
 * Pone en cola la edición de la semana para los contactos Activos. Solo actúa el día de envío
 * y solo si hay modelos nuevos que mostrar. La clave lleva la semana: una edición no se repite.
 */
export async function planNewsletter(cfg, now = new Date()) {
  if (!cfg.newsletterEnabled) return { planned: 0, reason: 'apagado' };
  if (!cfg.start || now < cfg.start) return { planned: 0, reason: 'sin corte' };
  if (!isNewsletterDay(now)) return { planned: 0, reason: 'no es día de envío' };

  const week = weekKey(now);
  const already = await prisma.emailLog.count({
    where: { kind: NEWSLETTER_STEP.kind, dedupeKey: { endsWith: `:${week}` } },
  });
  if (already) return { planned: 0, reason: 'edición ya planificada' };

  const fresh = await loadFreshAssets(now);
  if (fresh.filter((a) => pickImagePath(a.images, thumbOnDisk)).length < NEWSLETTER_MIN_MODELS) {
    return { planned: 0, reason: 'sin novedades' };
  }

  const contacts = await prisma.emailContact.findMany({
    where: {
      stage: 'ACTIVE',
      optedOutAt: null,
      user: { isActive: true, roleId: { not: 2 } },
    },
    select: { id: true, userId: true, user: { select: { registerCountry: true } } },
  });

  const rows = contacts.map((c) => ({
    contactId: c.id,
    kind: NEWSLETTER_STEP.kind,
    templateId: NEWSLETTER_STEP.templateId,
    status: 'QUEUED',
    scheduledFor: clampToSendWindow(now, timezoneForCountry(c.user.registerCountry), cfg.window),
    dedupeKey: `${NEWSLETTER_STEP.kind}:${c.userId}:${week}`,
  }));

  const result = rows.length ? await prisma.emailLog.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  return { planned: result.count, week };
}

export default {
  NEWSLETTER_STEP,
  weekdayOf,
  weekKey,
  isNewsletterDay,
  newsletterSkip,
  pickImagePath,
  buildModels,
  loadFreshAssets,
  loadDownloadedByUser,
  modelsForUser,
  planNewsletter,
};

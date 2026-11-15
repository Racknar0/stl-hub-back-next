// Campañas manuales: un correo puntual que el admin elige, dirige a una audiencia y lanza.
//
// Flujo:
//   1. Se crea un borrador: nombre, plantilla de Brevo, audiencia y ritmo.
//   2. Se prueba (llega al correo del admin) y se lanza ahora o se programa para una fecha.
//   3. Al lanzar, cada destinatario entra a la cola del motor (`emaillog`) con su hora de envío.
//      El motor los manda al ritmo de siempre, respetando cupo diario y ventana horaria.
//
// Las campañas se guardan como una lista en los ajustes del sistema (clave EMAIL_CAMPAIGNS): son
// pocas y así no hace falta tocar el esquema. Los envíos se reconocen por su clave anti-duplicados
// `CAMPAIGN:<id>:<idUsuario>`, que además impide mandar dos veces la misma campaña a la misma persona.

import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import emailMarketing from './emailMarketing.service.js';
import { clampToSendWindow, timezoneForCountry } from '../utils/emailSchedule.js';
import { CAMPAIGN_PREFIX } from './emailSends.service.js';

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTING_KEY = 'EMAIL_CAMPAIGNS';

export const AUDIENCES = ['ACTIVE', 'DORMANT', 'NEW', 'ALL'];
export const PLANS = ['all', 'free', 'premium'];
export const STATUSES = ['DRAFT', 'SCHEDULED', 'LAUNCHED', 'CANCELLED'];
export const DEFAULT_DAILY_CAP = 100;
export const MAX_DAILY_CAP = 500;
export const MAX_CAMPAIGNS = 200;

// ---------------------------------------------------------------- Funciones puras

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Valida lo que llega del panel. Devuelve { error } o { value } ya limpio. */
export function validateCampaignInput(body = {}) {
  const name = String(body.name ?? '').trim();
  if (!name) return { error: 'La campaña necesita un nombre' };
  if (name.length > 80) return { error: 'El nombre admite hasta 80 caracteres' };

  const templateId = Number(body.templateId);
  if (!Number.isInteger(templateId) || templateId < 1) return { error: 'Elige una plantilla de Brevo' };

  const audience = body.audience ?? 'ACTIVE';
  if (!AUDIENCES.includes(audience)) return { error: 'Audiencia no válida' };

  const plan = body.plan ?? 'all';
  if (!PLANS.includes(plan)) return { error: 'Plan no válido' };

  const dailyCap = body.dailyCap === undefined || body.dailyCap === '' ? DEFAULT_DAILY_CAP : Number(body.dailyCap);
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > MAX_DAILY_CAP) {
    return { error: `El ritmo debe ser un entero entre 1 y ${MAX_DAILY_CAP} por día` };
  }

  let scheduledAt = null;
  if (body.scheduledAt) {
    scheduledAt = toDate(body.scheduledAt);
    if (!scheduledAt) return { error: 'La fecha programada no es válida' };
  }

  return { value: { name, templateId, audience, plan, dailyCap, scheduledAt: scheduledAt?.toISOString() || null } };
}

/** ¿Este contacto recibe la campaña? Nunca a quien se dio de baja ni a cuentas inactivas. */
export function isCampaignEligible(contact, { audience, plan }) {
  if (!contact.isActive || contact.optedOutAt) return false;
  if (audience === 'ALL') {
    if (!['NEW', 'ACTIVE', 'DORMANT'].includes(contact.stage)) return false;
  } else if (contact.stage !== audience) {
    return false;
  }
  if (plan === 'free' && contact.isPremium) return false;
  if (plan === 'premium' && !contact.isPremium) return false;
  return true;
}

/** Los más activos primero: si el cupo aprieta, a ellos les llega antes. */
export function sortRecipients(recipients) {
  const time = (c) => (c.lastSignal ? new Date(c.lastSignal).getTime() : 0);
  return [...recipients].sort((a, b) => time(b) - time(a));
}

/**
 * Filas de la cola de una campaña. Se reparten `dailyCap` por día para no acaparar el cupo
 * y dejar pasar los correos del embudo, que son más urgentes.
 */
export function planCampaignRows({ campaign, recipients, now, window, countryOf = () => null }) {
  return sortRecipients(recipients).map((c, i) => {
    const day = Math.floor(i / campaign.dailyCap);
    const base = new Date(now.getTime() + day * DAY_MS);
    return {
      contactId: c.contactId,
      kind: 'OTHER',
      templateId: campaign.templateId,
      status: 'QUEUED',
      scheduledFor: clampToSendWindow(base, timezoneForCountry(countryOf(c.userId)), window),
      dedupeKey: `${CAMPAIGN_PREFIX}${campaign.id}:${c.userId}`,
    };
  });
}

/** Resultados de una campaña a partir de sus envíos. */
export function summarizeResults(grouped = [], { opened = 0, clicked = 0 } = {}) {
  const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const out = {
    queued: by.QUEUED || 0,
    sent: by.SENT || 0,
    failed: by.FAILED || 0,
    skipped: by.SKIPPED || 0,
    opened,
    clicked,
  };
  out.total = out.queued + out.sent + out.failed + out.skipped;
  return out;
}

/** ¿Toca lanzar esta campaña programada? */
export const isDue = (campaign, now) =>
  campaign.status === 'SCHEDULED' && Boolean(campaign.scheduledAt) && new Date(campaign.scheduledAt) <= now;

const newId = () => crypto.randomBytes(3).toString('hex');

// ---------------------------------------------------------------- Almacén

export async function readCampaigns() {
  const row = await prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row?.value) return [];
  try {
    const list = JSON.parse(row.value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeCampaigns(list) {
  const value = JSON.stringify(list);
  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value },
    create: { key: SETTING_KEY, value, description: 'Campañas manuales del panel Marketing' },
  });
}

/** Lee la lista, aplica un cambio y la guarda. */
async function mutate(fn) {
  const list = await readCampaigns();
  const result = await fn(list);
  await writeCampaigns(list);
  return result;
}

const find = (list, id) => list.find((c) => c.id === String(id));

// ---------------------------------------------------------------- Operaciones

/** Cuántos contactos recibirían una campaña con esa audiencia y plan. */
export async function countRecipients({ audience, plan }) {
  const snapshot = await emailMarketing.buildContactSnapshot();
  return snapshot.filter((c) => isCampaignEligible(c, { audience, plan })).length;
}

/** Resultados por campaña (una consulta agrupada por campaña). */
async function resultsFor(campaign) {
  const where = { dedupeKey: { startsWith: `${CAMPAIGN_PREFIX}${campaign.id}:` } };
  const [grouped, opened, clicked] = await Promise.all([
    prisma.emailLog.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.emailLog.count({ where: { ...where, openedAt: { not: null } } }),
    prisma.emailLog.count({ where: { ...where, clickedAt: { not: null } } }),
  ]);
  return summarizeResults(grouped, { opened, clicked });
}

/** Todas las campañas, las más nuevas primero, con sus resultados. */
export async function listCampaigns() {
  const list = await readCampaigns();
  const items = await Promise.all(
    list.map(async (c) => ({ ...c, results: c.status === 'LAUNCHED' || c.status === 'CANCELLED' ? await resultsFor(c) : null }))
  );
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function createCampaign(input) {
  const { error, value } = validateCampaignInput(input);
  if (error) return { error };
  return mutate((list) => {
    if (list.length >= MAX_CAMPAIGNS) return { error: 'Hay demasiadas campañas: borra alguna vieja' };
    const campaign = { id: newId(), ...value, status: 'DRAFT', createdAt: new Date().toISOString(), launchedAt: null, queued: 0 };
    list.push(campaign);
    return { campaign };
  });
}

export async function updateCampaign(id, input) {
  const { error, value } = validateCampaignInput(input);
  if (error) return { error };
  return mutate((list) => {
    const campaign = find(list, id);
    if (!campaign) return { error: 'Campaña no encontrada', status: 404 };
    if (campaign.status !== 'DRAFT') return { error: 'Solo se puede editar un borrador' };
    Object.assign(campaign, value);
    return { campaign };
  });
}

export async function deleteCampaign(id) {
  return mutate((list) => {
    const i = list.findIndex((c) => c.id === String(id));
    if (i < 0) return { error: 'Campaña no encontrada', status: 404 };
    if (!['DRAFT', 'CANCELLED'].includes(list[i].status)) {
      return { error: 'Una campaña lanzada no se borra: cancélala primero' };
    }
    list.splice(i, 1);
    return { ok: true };
  });
}

/** Pone en cola a los destinatarios. Se llama al lanzar y cuando llega la hora de una programada. */
async function enqueue(campaign, cfg, now) {
  const snapshot = await emailMarketing.buildContactSnapshot();
  const recipients = snapshot.filter((c) => isCampaignEligible(c, campaign));
  if (recipients.length === 0) return 0;

  const countries = await prisma.user.findMany({
    where: { id: { in: recipients.map((r) => r.userId) } },
    select: { id: true, registerCountry: true },
  });
  const countryOf = new Map(countries.map((u) => [u.id, u.registerCountry]));

  for (const r of recipients) {
    if (r.contactId) continue;
    const contact = await prisma.emailContact.upsert({
      where: { userId: r.userId },
      create: { userId: r.userId, stage: r.stage },
      update: {},
      select: { id: true },
    });
    r.contactId = contact.id;
  }

  const rows = planCampaignRows({
    campaign,
    recipients,
    now,
    window: cfg.window,
    countryOf: (userId) => countryOf.get(userId),
  });
  const result = await prisma.emailLog.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/**
 * Lanza una campaña: ahora, o la deja programada si `scheduledAt` es futura.
 * Un borrador y una programada se pueden lanzar; una lanzada o cancelada no.
 */
export async function launchCampaign(id, { cfg, now = new Date(), scheduledAt = null } = {}) {
  const when = toDate(scheduledAt);
  return mutate(async (list) => {
    const campaign = find(list, id);
    if (!campaign) return { error: 'Campaña no encontrada', status: 404 };
    if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) return { error: 'Esta campaña ya se lanzó o se canceló' };

    if (when && when > now) {
      campaign.status = 'SCHEDULED';
      campaign.scheduledAt = when.toISOString();
      return { campaign };
    }

    campaign.queued = await enqueue(campaign, cfg, now);
    campaign.status = 'LAUNCHED';
    campaign.launchedAt = now.toISOString();
    return { campaign, engineEnabled: cfg.enabled };
  });
}

/** Cancela: lo que aún está en cola se descarta; lo ya enviado no se puede deshacer. */
export async function cancelCampaign(id) {
  return mutate(async (list) => {
    const campaign = find(list, id);
    if (!campaign) return { error: 'Campaña no encontrada', status: 404 };
    if (campaign.status === 'CANCELLED') return { campaign };

    const dropped = await prisma.emailLog.updateMany({
      where: { dedupeKey: { startsWith: `${CAMPAIGN_PREFIX}${campaign.id}:` }, status: 'QUEUED' },
      data: { status: 'SKIPPED', lastError: 'campaña cancelada' },
    });
    campaign.status = 'CANCELLED';
    return { campaign, dropped: dropped.count };
  });
}

/** Lanza las programadas cuya hora llegó. Lo llama el ciclo del motor, solo con el motor encendido. */
export async function launchDue(cfg, now = new Date()) {
  const list = await readCampaigns();
  const due = list.filter((c) => isDue(c, now));
  let launched = 0;
  for (const c of due) {
    const out = await launchCampaign(c.id, { cfg, now });
    if (out.campaign?.status === 'LAUNCHED') launched += 1;
  }
  return { launched };
}

export async function getCampaign(id) {
  return find(await readCampaigns(), id) || null;
}

export default {
  AUDIENCES,
  PLANS,
  validateCampaignInput,
  isCampaignEligible,
  planCampaignRows,
  summarizeResults,
  isDue,
  countRecipients,
  listCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  launchCampaign,
  cancelCampaign,
  launchDue,
  getCampaign,
};

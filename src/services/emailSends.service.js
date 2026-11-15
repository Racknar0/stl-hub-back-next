// Historial de envíos del motor: cada fila de `emaillog`, en cola, enviada, fallida o descartada.
// Sirve a la pestaña "Envíos" del panel para ver qué se mandó, a quién y cómo le fue.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const SEND_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'];
export const SEND_KINDS = [
  'WELCOME_1',
  'WELCOME_2',
  'WELCOME_3',
  'WELCOME_4',
  'REENGAGE',
  'PREMIUM_EXPIRING',
  'PREMIUM_EXPIRED',
  'NEWSLETTER',
];

// Los envíos de una campaña manual llevan esta clave: CAMPAIGN:<idCampaña>:<idUsuario>.
export const CAMPAIGN_PREFIX = 'CAMPAIGN:';

/** Id de campaña a partir de la clave anti-duplicados, o null si el envío no es de una campaña. */
export function campaignIdOf(dedupeKey) {
  const key = String(dedupeKey || '');
  if (!key.startsWith(CAMPAIGN_PREFIX)) return null;
  return key.split(':')[1] || null;
}

/** Convierte los filtros de la URL en el `where` de Prisma. Lo desconocido se ignora. */
export function buildSendsWhere({ status, kind, q, campaign } = {}) {
  const where = {};

  if (SEND_STATUSES.includes(status)) where.status = status;

  if (kind === 'CAMPAIGN') where.dedupeKey = { startsWith: CAMPAIGN_PREFIX };
  else if (SEND_KINDS.includes(kind)) where.kind = kind;

  // Una campaña concreta (tiene prioridad sobre el tipo).
  if (campaign) where.dedupeKey = { startsWith: `${CAMPAIGN_PREFIX}${String(campaign).replace(/[^A-Za-z0-9_-]/g, '')}:` };

  const text = String(q || '').trim().slice(0, 100);
  if (text) where.contact = { user: { email: { contains: text } } };

  return where;
}

/** Normaliza página y tamaño de página. */
export function pageParams({ page, pageSize } = {}, { maxSize = 100, defaultSize = 25 } = {}) {
  const size = Math.min(maxSize, Math.max(1, Number(pageSize) || defaultSize));
  const current = Math.max(1, Math.floor(Number(page)) || 1);
  return { page: current, pageSize: size, skip: (current - 1) * size };
}

/** Listado paginado de envíos, del más nuevo al más viejo, con el conteo por estado. */
export async function listSends(query = {}) {
  const where = buildSendsWhere(query);
  const { page, pageSize, skip } = pageParams(query);

  // El conteo por estado respeta tipo y búsqueda, pero no el estado elegido.
  const { status: _status, ...withoutStatus } = query;
  const whereForCounts = buildSendsWhere(withoutStatus);

  const [items, total, grouped] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      orderBy: { id: 'desc' },
      skip,
      take: pageSize,
      include: { contact: { select: { userId: true, user: { select: { email: true } } } } },
    }),
    prisma.emailLog.count({ where }),
    prisma.emailLog.groupBy({ by: ['status'], where: whereForCounts, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(SEND_STATUSES.map((s) => [s, 0]));
  for (const g of grouped) counts[g.status] = g._count._all;

  return {
    page,
    pageSize,
    total,
    counts,
    items: items.map((l) => ({
      id: l.id,
      email: l.contact?.user?.email || null,
      kind: l.kind,
      campaignId: campaignIdOf(l.dedupeKey),
      templateId: l.templateId,
      status: l.status,
      scheduledFor: l.scheduledFor,
      sentAt: l.sentAt,
      deliveredAt: l.deliveredAt,
      openedAt: l.openedAt,
      clickedAt: l.clickedAt,
      bouncedAt: l.bouncedAt,
      attempts: l.attempts,
      error: l.lastError,
    })),
  };
}

export default { listSends, buildSendsWhere, pageParams, campaignIdOf, CAMPAIGN_PREFIX };

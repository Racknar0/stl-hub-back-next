import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Dominio público de los enlaces cortos (la ruta /v/<code> la atiende el front y redirige)
const SHORT_BASE = (process.env.SHORT_LINK_BASE || 'https://stlgratis.com/v').replace(/\/$/, '');
// Sin 0/O ni 1/l/I para que se puedan leer y escribir a mano sin confusiones
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 5;
// Código fijo para la bio de Instagram: siempre lleva al modelo del último reel publicado
export const BIO_CODE = 'hoy';

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slack|embedly|vkshare|bingpreview|google-inspectiontool|headless|curl|wget|python|axios|node-fetch/i;

export const shortUrl = (code) => `${SHORT_BASE}/${code}`;

function randomCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

/**
 * Devuelve la URL corta de un destino. Si ya existe uno con el mismo destino y origen se reutiliza
 * (así reintentar una publicación no crea enlaces duplicados).
 */
export async function createShortLink({ targetUrl, source, label = null, refType = null, refId = null }) {
  if (!targetUrl) return null;
  const existing = await prisma.shortLink.findFirst({ where: { targetUrl, source }, orderBy: { id: 'asc' } });
  if (existing) return shortUrl(existing.code);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const row = await prisma.shortLink.create({
        data: { code: randomCode(), targetUrl, source, label: label ? String(label).slice(0, 255) : null, refType, refId },
      });
      return shortUrl(row.code);
    } catch (e) {
      if (e?.code !== 'P2002') throw e; // P2002: el código ya existe → se prueba otro
    }
  }
  throw new Error('No se pudo crear un código corto único');
}

/** Igual que createShortLink, pero si falla devuelve la URL larga para no bloquear la publicación. */
export async function shortOrLong(params) {
  try {
    return (await createShortLink(params)) || params.targetUrl;
  } catch (e) {
    console.warn('[SHORT] No se pudo acortar, se usa el enlace largo:', e.message);
    return params.targetUrl;
  }
}

/** Enlace de código fijo (p. ej. "hoy"): crea o cambia su destino. */
export async function setFixedLink(code, { targetUrl, source, label = null, refType = null, refId = null }) {
  if (!targetUrl) return null;
  await prisma.shortLink.upsert({
    where: { code },
    create: { code, targetUrl, source, label, refType, refId },
    update: { targetUrl, label, refType, refId },
  });
  return shortUrl(code);
}

/** Destino de un código corto; suma el clic salvo que venga de un bot. null si no existe. */
export async function resolveShortLink(code, { userAgent = '' } = {}) {
  const clean = String(code || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(clean)) return null;
  const link = await prisma.shortLink.findUnique({ where: { code: clean } });
  if (!link) return null;
  if (!BOT_UA.test(String(userAgent))) {
    await prisma.$transaction([
      prisma.shortLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 }, lastClickAt: new Date() } }),
      prisma.shortLinkClick.create({ data: { shortLinkId: link.id, source: link.source } }),
    ]).catch(e => console.warn('[SHORT] No se pudo registrar el clic:', e.message));
  }
  return link.targetUrl;
}

const SOURCES = ['youtube_horizontal', 'facebook', 'youtube_short', 'threads', 'bluesky', 'tumblr', 'instagram_bio'];

/** Enlaces cortos con sus clics (para el panel), más los totales por origen. */
export async function listShortLinks({ source = null, q = '', limit = 300 } = {}) {
  const where = {
    ...(source && SOURCES.includes(source) ? { source } : {}),
    ...(q ? { OR: [{ label: { contains: String(q) } }, { targetUrl: { contains: String(q) } }, { code: { contains: String(q).toLowerCase() } }] } : {}),
  };
  const [rows, grouped] = await Promise.all([
    prisma.shortLink.findMany({
      where,
      orderBy: [{ clicks: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 300, 1), 1000),
    }),
    prisma.shortLink.groupBy({ by: ['source'], where: { source: { in: SOURCES } }, _count: { _all: true }, _sum: { clicks: true } }),
  ]);
  const bySource = SOURCES.map((s) => {
    const g = grouped.find(x => x.source === s);
    return { source: s, links: g?._count?._all || 0, clicks: g?._sum?.clicks || 0 };
  });
  return {
    totals: {
      links: bySource.reduce((a, b) => a + b.links, 0),
      clicks: bySource.reduce((a, b) => a + b.clicks, 0),
      bySource,
    },
    links: rows.map(r => ({
      id: r.id, code: r.code, shortUrl: shortUrl(r.code), targetUrl: r.targetUrl, source: r.source, label: r.label,
      refType: r.refType, refId: r.refId, clicks: r.clicks, lastClickAt: r.lastClickAt, createdAt: r.createdAt,
    })),
  };
}

export default { createShortLink, shortOrLong, setFixedLink, resolveShortLink, listShortLinks, shortUrl, BIO_CODE };

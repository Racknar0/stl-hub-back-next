/**
 * Genera los capítulos con enlaces cortos de una recopilación horizontal ya publicada, para pegarlos a mano
 * en la descripción de YouTube (los videos subidos antes del acortador llevan enlaces /stl/<id> que dan 404).
 *
 * Uso: node --env-file=.env scripts/shortenHorizontalChapters.js [idRecopilacion]
 *      (sin id: la última recopilación publicada)
 *
 * Solo crea filas en la tabla de enlaces cortos (como hace la app al publicar); no cambia nada en YouTube.
 */
import { PrismaClient } from '@prisma/client';
import { createShortLink } from '../src/services/shortLinks.service.js';

const prisma = new PrismaClient();
const CLIP_SECONDS = 10;

async function main() {
  const idArg = Number(process.argv[2]);
  const record = idArg
    ? await prisma.horizontalCompilation.findUnique({ where: { id: idArg } })
    : await prisma.horizontalCompilation.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' } });
  if (!record) throw new Error('No se encontró la recopilación');

  const tags = record.tags && typeof record.tags === 'object' ? record.tags : {};
  const language = tags.language === 'en' ? 'en' : 'es';
  const channel = record.channelName || record.channelId;
  const modelIds = Array.isArray(record.modelIds) ? record.modelIds.map(Number) : [];
  const reels = await prisma.reelPost.findMany({ where: { id: { in: modelIds } }, select: { id: true, assetId: true, link: true } });
  const reelById = new Map(reels.map(r => [r.id, r]));
  const assetIds = reels.map(r => r.assetId).filter(Boolean);
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, slug: true } });
  const slugById = new Map(assets.map(a => [a.id, a.slug]));

  // Títulos tal cual se publicaron (líneas "0:00 - #1 Título (enlace)")
  const titleByIndex = new Map();
  for (const line of String(record.description || '').split('\n')) {
    const m = line.match(/#(\d+)\s+(.+?)\s+\(https?:\/\/[^)]*\)\s*$/);
    if (m) titleByIndex.set(Number(m[1]), m[2]);
  }

  const prefix = language === 'en' ? 'https://stlgratis.com/en/' : 'https://stlgratis.com/';
  const duration = Number(record.durationSec) || modelIds.length * CLIP_SECONDS;
  const header = language === 'en' ? '⏱️ CHAPTERS & DIRECT LINKS TO EACH MODEL:' : '⏱️ CAPÍTULOS Y ENLACES DIRECTOS A CADA MODELO:';
  const lines = [header];

  for (let i = 0; i < modelIds.length; i++) {
    const start = i * CLIP_SECONDS;
    if (start >= duration) break; // capítulos fuera del video: YouTube no los enlaza
    const reel = reelById.get(modelIds[i]);
    const slug = reel?.assetId ? slugById.get(reel.assetId) : null;
    const base = slug
      ? `${prefix}asset/${slug}`
      : (reel?.link ? String(reel.link).replace(/https:\/\/stlgratis\.com\/((es|en)\/)?/, prefix) : prefix);
    const url = new URL(base);
    url.searchParams.set('utm_source', 'youtube');
    url.searchParams.set('utm_medium', 'video');
    url.searchParams.set('utm_campaign', String(channel).toLowerCase());
    const title = titleByIndex.get(i + 1) || `Modelo ${modelIds[i]}`;
    const short = await createShortLink({
      targetUrl: url.toString(), source: 'youtube_horizontal', label: `${channel} · #${i + 1} ${title}`,
      refType: 'horizontal', refId: record.id,
    });
    lines.push(`${Math.floor(start / 60)}:${String(start % 60).padStart(2, '0')} - #${i + 1} ${title} (${short})`);
  }

  console.log(`Recopilación #${record.id} · ${channel} · ${language} · ${record.youtubeUrl || 'sin URL'}\n`);
  console.log(lines.join('\n'));
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

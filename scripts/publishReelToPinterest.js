/**
 * Publica en Pinterest (pin de video) un reel que ya salió en las demás redes, para probar la integración
 * o completar reels antiguos. Guarda el resultado en el reel como una red más.
 *
 * Uso: node --env-file=.env scripts/publishReelToPinterest.js [idReel] [--link=<url>]
 *      (sin id: el último reel publicado que aún no está en Pinterest; --link cambia el enlace del pin para probar)
 */
import { PrismaClient } from '@prisma/client';
import pinterestPublisher from '../src/services/pinterestPublisher.service.js';
import { pinterestTexts, pinterestLink, toAbsVideoPath } from '../src/services/reels.service.js';

const prisma = new PrismaClient();

async function main() {
  const idArg = Number(process.argv.find(a => /^\d+$/.test(a)));
  const linkArg = (process.argv.find(a => a.startsWith('--link=')) || '').slice('--link='.length);
  let post;
  if (idArg) {
    post = await prisma.reelPost.findUnique({ where: { id: idArg } });
  } else {
    const recent = await prisma.reelPost.findMany({ where: { status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' }, take: 20 });
    post = recent.find(p => !(p.results && typeof p.results === 'object' && p.results.pinterest?.id));
  }
  if (!post) throw new Error('No se encontró el reel');
  const results = post.results && typeof post.results === 'object' ? { ...post.results } : {};
  if (results.pinterest?.id) throw new Error(`El reel ${post.id} ya está en Pinterest: ${results.pinterest.url}`);

  const texts = pinterestTexts(post);
  console.log(`Reel #${post.id} · ${texts.title}\nSubiendo el video a Pinterest (puede tardar unos minutos)…`);
  const result = await pinterestPublisher.publishVideoPin({
    videoAbsPath: toAbsVideoPath(post.videoPath),
    ...texts,
    link: linkArg || pinterestLink(post),
    assetId: post.assetId,
  });

  results.pinterest = { ...result, publishedAt: new Date().toISOString(), simulated: false };
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  await prisma.reelPost.update({
    where: { id: post.id },
    data: { results, platforms: platforms.includes('pinterest') ? platforms : [...platforms, 'pinterest'] },
  });
  console.log(`Publicado: ${result.url}`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

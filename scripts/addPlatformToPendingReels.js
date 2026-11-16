/**
 * Añade una red (por defecto Pinterest) a todos los reels que aún no se han publicado, para que salgan también ahí
 * cuando llegue su hora. No toca los reels publicados ni los que se están publicando.
 *
 * Uso: node --env-file=.env scripts/addPlatformToPendingReels.js [red]   (red: pinterest, threads, …)
 */
import { PrismaClient } from '@prisma/client';
import { PLATFORMS } from '../src/services/reels.service.js';

const prisma = new PrismaClient();

async function main() {
  const platform = (process.argv[2] || 'pinterest').toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new Error(`Red desconocida: ${platform}. Válidas: ${PLATFORMS.join(', ')}`);

  const pending = await prisma.reelPost.findMany({
    where: { status: { not: 'PUBLISHED' }, publishing: false },
    select: { id: true, platforms: true, scheduledAt: true, status: true },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
  });
  let added = 0;
  for (const post of pending) {
    const platforms = Array.isArray(post.platforms) ? post.platforms : [];
    if (platforms.includes(platform)) continue;
    await prisma.reelPost.update({ where: { id: post.id }, data: { platforms: [...platforms, platform] } });
    added += 1;
  }
  console.log(`Reels sin publicar: ${pending.length} · se añadió ${platform} a ${added} (los demás ya la tenían)`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

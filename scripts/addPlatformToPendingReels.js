/**
 * Añade una red (por defecto Pinterest) a todos los reels que aún no se han publicado, para que salgan también ahí
 * cuando llegue su hora. No toca los reels publicados ni los que se están publicando.
 *
 * Uso: node --env-file=.env scripts/addPlatformToPendingReels.js [red]   (red: pinterest, threads, …)
 */
import { PrismaClient } from '@prisma/client';
import { PLATFORMS, reelsMissingPlatform, addPlatformToPending } from '../src/services/reels.service.js';

const prisma = new PrismaClient();

async function main() {
  const platform = (process.argv[2] || 'pinterest').toLowerCase();
  if (!PLATFORMS.includes(platform)) throw new Error(`Red desconocida: ${platform}. Válidas: ${PLATFORMS.join(', ')}`);

  const missing = (await reelsMissingPlatform(platform)).length;
  const { added } = await addPlatformToPending(platform);
  console.log(`Reels sin publicar sin ${platform}: ${missing} · se añadió a ${added}`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

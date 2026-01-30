import { PrismaClient } from '@prisma/client';

function parseCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export function getRandomizeFreebiesCountFromEnv(env = process.env) {
  // Nombres soportados (por compatibilidad y claridad)
  // - FREEBIES_RANDOMIZE_COUNT: recomendado
  // - RANDOMIZE_FREE_COUNT: alternativo
  const raw = env.FREEBIES_RANDOMIZE_COUNT ?? env.RANDOMIZE_FREE_COUNT;
  const n = parseCount(raw);
  return n == null ? 0 : n;
}

/**
 * Randomiza freebies:
 * - Marca todos los assets PUBLISHED como premium
 * - Selecciona N aleatorios y los deja como free (isPremium=false)
 */
export async function randomizeFreebies({
  count,
  prisma,
  where = { status: 'PUBLISHED' },
} = {}) {
  const n = parseCount(count);
  const effectiveN = n == null ? 0 : n;

  const client = prisma || new PrismaClient();
  const ownsClient = !prisma;

  try {
    const total = await client.asset.count({ where });
    if (total === 0) return { total: 0, selected: 0, count: effectiveN };

    await client.asset.updateMany({ where, data: { isPremium: true } });

    if (effectiveN <= 0) return { total, selected: 0, count: effectiveN };

    const rows = await client.asset.findMany({ where, select: { id: true } });
    const ids = rows.map((r) => r.id);

    // Fisher-Yates
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = ids[i];
      ids[i] = ids[j];
      ids[j] = tmp;
    }

    const pick = ids.slice(0, Math.min(effectiveN, ids.length));
    await client.asset.updateMany({
      where: { id: { in: pick } },
      data: { isPremium: false },
    });

    return { total, selected: pick.length, count: effectiveN };
  } finally {
    if (ownsClient) {
      try {
        await client.$disconnect();
      } catch {}
    }
  }
}

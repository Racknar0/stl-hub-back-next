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
 * Randomiza freebies usando la tabla dailyFreebie.
 * - Limpia los freebies de hoy en dailyFreebie (idempotente)
 * - Selecciona N assets publicados aleatorios y los inserta en dailyFreebie
 * - NO modifica la tabla asset (cero impacto en SEO / I/O)
 */
export async function randomizeFreebies({
  count,
  prisma,
  where = { status: 'PUBLISHED' },
} = {}) {
  const client = prisma || new PrismaClient();
  const ownsClient = !prisma;

  try {
    let dbCount = null;
    const setting = await client.systemSetting.findUnique({ where: { key: 'FREEBIES_DAILY_COUNT' } });
    if (setting && setting.value) {
      dbCount = parseCount(setting.value);
    }

    let effectiveN = 0;
    if (dbCount != null) {
      effectiveN = dbCount;
    } else {
      const n = parseCount(count);
      effectiveN = n == null ? 0 : n;
    }
    const total = await client.asset.count({ where });
    if (total === 0) return { total: 0, selected: 0, count: effectiveN };

    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;

    // Limpiar freebies de hoy (idempotente para re-ejecuciones)
    await client.dailyFreebie.deleteMany({ where: { date: today } });

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

    // Insertar los freebies de hoy en la tabla separada
    await client.dailyFreebie.createMany({
      data: pick.map((assetId) => ({ assetId, date: today })),
      skipDuplicates: true,
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

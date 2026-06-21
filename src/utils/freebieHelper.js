/**
 * Helpers para el sistema de freebies diarios.
 *
 * En lugar de alternar asset.isPremium, los freebies se rastrean
 * en la tabla dailyFreebie. Estos helpers calculan el estado
 * de freebie en runtime sin modificar la tabla asset.
 */

/**
 * Devuelve la fecha de hoy en formato "YYYY-MM-DD".
 */
export function getTodayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Dado un array de assets (objetos con { id, ... }),
 * enriquece cada uno con un campo `isPremium` calculado:
 *   - false si el asset está en dailyFreebie para hoy
 *   - true en caso contrario
 *
 * @param {Array} assets - Array de objetos asset con al menos { id }
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<Array>} Assets con isPremium inyectado
 */
export async function enrichFreebieStatus(assets, prisma) {
  if (!assets || assets.length === 0) return assets;

  const today = getTodayDateStr();
  const assetIds = assets.map((a) => a.id).filter(Boolean);

  if (assetIds.length === 0) return assets;

  const freebies = await prisma.dailyFreebie.findMany({
    where: { date: today, assetId: { in: assetIds } },
    select: { assetId: true },
  });

  const freeSet = new Set(freebies.map((f) => f.assetId));

  return assets.map((a) => ({
    ...a,
    isPremium: a.isPremium === false ? false : !freeSet.has(a.id),
  }));
}

/**
 * Verifica si un asset individual es gratuito hoy.
 *
 * @param {number} assetId
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<boolean>} true si el asset es free hoy
 */
export async function isAssetFreeToday(assetId, prisma) {
  const today = getTodayDateStr();
  const entry = await prisma.dailyFreebie.findUnique({
    where: { assetId_date: { assetId, date: today } },
  });
  return !!entry;
}

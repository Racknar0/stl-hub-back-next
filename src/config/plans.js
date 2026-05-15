import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Precios por defecto (fallback si no existe PLAN_PRICES en SystemSetting) ───
const DEFAULT_PRICES = {
  '1m': '5.00',
  '3m': '10.00',
  '6m': '17.00',
  '12m': '25.00',
};

// ─── Estructura base de los planes (periodos fijos, precios dinámicos) ───
function buildPlans(prices = DEFAULT_PRICES) {
  return {
    '1m': {
      name_es: 'Suscripción 30 Días',
      name_en: '30 Day Subscription',
      price: String(prices['1m'] || DEFAULT_PRICES['1m']),
      currency: 'USD',
      durationDays: 30,
    },
    '3m': {
      name_es: 'Suscripción 90 Días',
      name_en: '90 Day Subscription',
      price: String(prices['3m'] || DEFAULT_PRICES['3m']),
      currency: 'USD',
      durationDays: 90,
    },
    '6m': {
      name_es: 'Suscripción 180 Días',
      name_en: '180 Day Subscription',
      price: String(prices['6m'] || DEFAULT_PRICES['6m']),
      currency: 'USD',
      durationDays: 180,
    },
    '12m': {
      name_es: 'Suscripción 365 Días',
      name_en: '365 Day Subscription',
      price: String(prices['12m'] || DEFAULT_PRICES['12m']),
      currency: 'USD',
      durationDays: 365,
    },
  };
}

/**
 * Lee los precios dinámicos de SystemSetting y devuelve el objeto de planes.
 * Sin caché: cada llamada lee directo de la BD para reflejar cambios al instante.
 * Si falla la BD o no existe la key, usa los precios por defecto.
 */
export async function getPlans() {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: 'PLAN_PRICES' },
    });

    if (setting?.value) {
      const parsed = JSON.parse(setting.value);
      if (parsed && typeof parsed === 'object') {
        return buildPlans(parsed);
      }
    }
  } catch (err) {
    console.warn('[PLANS] Error leyendo PLAN_PRICES de SystemSetting, usando defaults:', err?.message || err);
  }

  return buildPlans(DEFAULT_PRICES);
}

// Export estático con precios default para compatibilidad
const plans = buildPlans(DEFAULT_PRICES);
export default plans;
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { log } from './logger.js';

// Cargar variables de entorno (si existen)
dotenv.config();

const prisma = new PrismaClient();

/**
 * Valida y corrige estados de suscripciones y usuarios.
 * - Marca como EXPIRED las suscripciones ACTIVE cuyo currentPeriodEnd ya pasó.
 * - (Opcional) Activa/desactiva usuarios según tengan o no suscripción activa (excepto admins roleId=2).
 * Devuelve un resumen de cambios.
 */
export async function runAccountValidation(options = { toggleUserActive: true }) {
  const now = new Date();
  const summary = {
    expiredSubscriptions: 0,
    usersActivated: 0,
    usersDeactivated: 0,
    startedAt: now.toISOString(),
  };

  // 1. Expirar suscripciones vencidas
  const expired = await prisma.subscription.updateMany({
    where: {
      status: 'ACTIVE',
      currentPeriodEnd: { lt: now },
    },
    data: { status: 'EXPIRED' },
  });
  summary.expiredSubscriptions = expired.count;

  if (options.toggleUserActive) {
    // 2. Obtener usuarios (excluyendo admins) y determinar si tienen una suscripción activa vigente
    const users = await prisma.user.findMany({
      select: { id: true, roleId: true, isActive: true },
    });
    const activeSubs = await prisma.subscription.findMany({
      where: { status: 'ACTIVE', currentPeriodEnd: { gt: now } },
      select: { userId: true },
    });
    const activeSet = new Set(activeSubs.map(s => s.userId));

    const toActivate = [];
    const toDeactivate = [];
    for (const u of users) {
      if (u.roleId === 2) continue; // nunca tocar admins
      const shouldBeActive = activeSet.has(u.id);
      if (shouldBeActive && !u.isActive) toActivate.push(u.id);
      else if (!shouldBeActive && u.isActive) toDeactivate.push(u.id);
    }
    if (toActivate.length) {
      await prisma.user.updateMany({ where: { id: { in: toActivate } }, data: { isActive: true } });
      summary.usersActivated = toActivate.length;
    }
    if (toDeactivate.length) {
      await prisma.user.updateMany({ where: { id: { in: toDeactivate } }, data: { isActive: false } });
      summary.usersDeactivated = toDeactivate.length;
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

// Ejecución directa: `node src/utils/validateAccounts.js`
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  (async () => {
  log.info('Validación de cuentas iniciada');
    try {
      const result = await runAccountValidation();
  log.info('Resumen validación cuentas: ' + JSON.stringify(result));
      process.exit(0);
    } catch (e) {
  log.error('Error validación cuentas: ' + (e?.message || e));
      process.exit(1);
    } finally {
      await prisma.$disconnect();
    }
  })();
}

export default runAccountValidation;
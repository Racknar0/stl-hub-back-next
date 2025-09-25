// utils/megaCheckFiles/visitTriggeredMegaCheck.js
import { PrismaClient } from '@prisma/client';
import { checkMegaLinkAlive } from './megaLinkChecker.js';

const prisma = new PrismaClient();
const running = new Set(); // lock barato por assetId

// === Config ===
// Cambia aquí los días por defecto (o usa la env MEGA_CHECK_TTL_DAYS)
const TTL_DAYS_DEFAULT = 7;
const TTL_DAYS = Number(process.env.MEGA_CHECK_TTL_DAYS ?? TTL_DAYS_DEFAULT);
// Asegura que sea un número válido y >= 1
const TTL_MS = Math.max(1, TTL_DAYS) * 24 * 60 * 60 * 1000;

export function maybeCheckMegaOnVisit(asset) {
  try {
    if (!asset?.id || !asset?.megaLink) return;

    const lastTs = asset.megaLinkCheckedAt ? new Date(asset.megaLinkCheckedAt).getTime() : 0;
    const fresh = lastTs && (Date.now() - lastTs) < TTL_MS;
    if (fresh) return;

    if (running.has(asset.id)) return;
    running.add(asset.id);

    // fire-and-forget (no bloquea la respuesta al usuario)
    (async () => {
      // Respeta TTL (force: false) y desactiva logs por defecto
      const alive = await checkMegaLinkAlive(asset.megaLink, { force: false, log: false });

      // Persistir estado actual
      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          megaLinkAlive: !!alive,
          megaLinkCheckedAt: new Date(),
        },
      });

      // Notificar solo si pasó de vivo/null -> caído
      if (alive === false && asset.megaLinkAlive !== false) {
        try {
          await prisma.notification.create({
            data: {
              title: 'Asset reportado como caído',
              body: `El sistema detectó que el asset "${asset.title ?? '(sin título)'}" (id: ${asset.id}) tiene el enlace de MEGA caído.`,
              status: 'UNREAD',
              type: 'REPORT',
              typeStatus: 'PENDING',
            },
          });
        } catch (e) {
          console.error('[MEGA CHECK] error creando notificación:', e?.message || e);
        }
      }
    })().finally(() => running.delete(asset.id));
  } catch (e) {
    // noop
    console.error('[MEGA CHECK] maybeCheckMegaOnVisit error:', e?.message || e);
  }
}
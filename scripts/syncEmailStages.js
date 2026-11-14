// Recalcula la etapa de marketing de cada contacto (nuevo / activo / dormido / fuera).
//
// Pensado para un cron diario en el VPS:
//   0 6 * * *  cd /ruta/backend && node --env-file=.env scripts/syncEmailStages.js
//
// Es idempotente: se puede ejecutar las veces que haga falta.

import svc from '../src/services/emailMarketing.service.js';

const run = async () => {
  const started = Date.now();
  console.log('[sync-email-stages] iniciando…');
  console.log('[sync-email-stages] ventanas:', svc.WINDOWS);

  const result = await svc.syncStages();

  console.log(
    `[sync-email-stages] ${result.total} contactos · ${result.created} creados · ` +
      `${result.updated} actualizados · ${Date.now() - started} ms`
  );
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[sync-email-stages] error:', e);
    process.exit(1);
  });

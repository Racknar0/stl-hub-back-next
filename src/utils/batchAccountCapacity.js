// Regla única de espacio para Upload Batch.
// Una cuenta (main o backup) nunca debe superar el 95 % de su tamaño real: es el mismo
// punto al que "Depurar exceso" deja las cuentas, así que el batch no las lleva a depuración.

export const BATCH_ACCOUNT_MAX_PCT = 0.95;
// Tope cuando no se conoce el tamaño real de la cuenta
const FALLBACK_LIMIT_MB = 18 * 1024;
// Techo absoluto opcional, además del porcentaje
const ENV_MAX_MB = Number(process.env.BATCH_ACCOUNT_MAX_MB) || 0;

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function batchAccountLimitMb(totalMB) {
  const total = num(totalMB);
  const byPct = total > 0 ? total * BATCH_ACCOUNT_MAX_PCT : FALLBACK_LIMIT_MB;
  return ENV_MAX_MB > 0 ? Math.min(byPct, ENV_MAX_MB) : byPct;
}

// MB que aún admite la cuenta; extraMb = lo ya comprometido (cola, sesión en curso)
export function batchAccountFreeMb(account, extraMb = 0) {
  return Math.max(0, batchAccountLimitMb(account?.storageTotalMB) - num(account?.storageUsedMB) - Math.max(0, num(extraMb)));
}

export const isActiveBatchBackup = backup => Boolean(backup) && String(backup.status || '').toUpperCase() !== 'SUSPENDED';

// Libre utilizable de una main: el menor entre ella y sus backups activos
export function batchUsableFreeMb(main, backups = [], extraOf = () => 0) {
  let free = batchAccountFreeMb(main, extraOf(main?.id));
  for (const backup of backups) {
    if (!isActiveBatchBackup(backup)) continue;
    free = Math.min(free, batchAccountFreeMb(backup, extraOf(backup.id)));
  }
  return free;
}

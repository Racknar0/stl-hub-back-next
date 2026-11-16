// Cola del cron de revisión de cuentas (autoBackupAssetsToMain).
//
// El cron toma siempre el grupo (MAIN + backups) con la revisión más antigua. Si ese grupo falla
// antes de actualizar su fecha, seguiría siendo el más antiguo y se reintentaría cada hora,
// bloqueando a todos los demás. Para evitarlo se anota cada fallo y el grupo queda "en pausa"
// un rato, cada vez más largo: mientras tanto el cron sigue con los siguientes.
//
// La fecha de última revisión NO se toca al fallar: una cuenta sin revisar debe seguir viéndose
// como tal en el panel.

import fs from 'fs';

const HOUR_MS = 60 * 60 * 1000;
export const BASE_COOLDOWN_HOURS = 2;
export const MAX_COOLDOWN_HOURS = 24;

/** Horas de pausa tras `count` fallos seguidos: 2, 4, 8, 16 y luego 24. */
export function cooldownHours(count) {
  const n = Math.max(1, Number(count) || 1);
  return Math.min(MAX_COOLDOWN_HOURS, BASE_COOLDOWN_HOURS * 2 ** (n - 1));
}

/** ¿El grupo sigue en pausa por un fallo reciente? */
export function isCoolingDown(entry, now = Date.now()) {
  if (!entry?.at) return false;
  const at = new Date(entry.at).getTime();
  if (Number.isNaN(at)) return false;
  return now - at < cooldownHours(entry.count) * HOUR_MS;
}

/**
 * Ordena los grupos: primero los que no están en pausa, del más antiguo al más nuevo;
 * al final los que fallaron hace poco. Así un grupo roto nunca deja sin turno al resto,
 * y si todos están en pausa se sigue intentando con el más antiguo.
 */
export function orderGroups(scored, failures = {}, now = Date.now()) {
  const ready = [];
  const paused = [];
  for (const item of scored) {
    (isCoolingDown(failures[item.m.id], now) ? paused : ready).push(item);
  }
  const byOldest = (a, b) => a.oldestTs - b.oldestTs;
  return [...ready.sort(byOldest), ...paused.sort(byOldest)];
}

/** Anota un fallo del grupo (suma uno a la racha). Devuelve un mapa nuevo. */
export function recordFailure(failures = {}, mainId, now = Date.now(), message = '') {
  const prev = failures[mainId];
  return {
    ...failures,
    [mainId]: {
      count: (prev?.count || 0) + 1,
      at: new Date(now).toISOString(),
      error: String(message || '').slice(0, 200),
    },
  };
}

/** Quita la racha de fallos de un grupo que ya se revisó bien. Devuelve un mapa nuevo. */
export function clearFailure(failures = {}, mainId) {
  if (!(mainId in failures)) return failures;
  const { [mainId]: _removed, ...rest } = failures;
  return rest;
}

/** Descarta anotaciones de grupos que ya no existen. */
export function pruneFailures(failures = {}, validIds = []) {
  const valid = new Set(validIds.map(String));
  return Object.fromEntries(Object.entries(failures).filter(([id]) => valid.has(String(id))));
}

/** Lee el archivo de fallos. Si falta o está dañado se empieza de cero. */
export function loadFailures(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** Guarda el archivo de fallos. Si no se puede escribir, el cron sigue igual. */
export function saveFailures(file, failures) {
  try {
    fs.writeFileSync(file, JSON.stringify(failures));
    return true;
  } catch {
    return false;
  }
}

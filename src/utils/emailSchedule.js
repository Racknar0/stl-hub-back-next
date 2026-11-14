// Cálculo de a qué hora local debe salir cada correo del embudo.
//
// Regla: se envía a la hora del día en que la persona se registró, según su país,
// pero siempre dentro de una ventana razonable (por defecto 9:00 a 20:00 locales).
// Si no conocemos su país se usa la zona de Colombia, que es el grueso de la audiencia.

export const DEFAULT_TIMEZONE = 'America/Bogota';

// País (ISO de 2 letras) -> zona horaria principal.
// Los países con varias zonas usan la de su capital o la más poblada.
export const COUNTRY_TIMEZONE = {
  CO: 'America/Bogota',
  MX: 'America/Mexico_City',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  PE: 'America/Lima',
  EC: 'America/Guayaquil',
  VE: 'America/Caracas',
  BO: 'America/La_Paz',
  PY: 'America/Asuncion',
  UY: 'America/Montevideo',
  CR: 'America/Costa_Rica',
  PA: 'America/Panama',
  GT: 'America/Guatemala',
  SV: 'America/El_Salvador',
  HN: 'America/Tegucigalpa',
  NI: 'America/Managua',
  DO: 'America/Santo_Domingo',
  CU: 'America/Havana',
  PR: 'America/Puerto_Rico',
  BR: 'America/Sao_Paulo',
  US: 'America/New_York',
  CA: 'America/Toronto',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  IT: 'Europe/Rome',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  NL: 'Europe/Amsterdam',
  AU: 'Australia/Sydney',
};

export const timezoneForCountry = (country) =>
  COUNTRY_TIMEZONE[String(country || '').toUpperCase()] || DEFAULT_TIMEZONE;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Partes de una fecha vista desde una zona horaria. */
export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Instante UTC que corresponde a esa fecha y hora locales en la zona dada. */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  // Primera aproximación: tratar la hora local como si fuera UTC y corregir por el desfase real.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const seen = zonedParts(new Date(guess), timeZone);
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  let result = guess - (seenAsUtc - guess);

  // Segunda pasada por si el desfase cambió entre la aproximación y el resultado (cambio de hora).
  const check = zonedParts(new Date(result), timeZone);
  const checkAsUtc = Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute, check.second);
  if (checkAsUtc !== guess) result -= checkAsUtc - guess;

  return new Date(result);
}

/**
 * Lleva un instante a la ventana de envío local.
 * - Antes de `startHour`: ese mismo día a `startHour`.
 * - Desde `endHour`: el día siguiente a `startHour`.
 * - Dentro de la ventana: sin cambios.
 */
export function clampToSendWindow(date, timeZone, { startHour = 9, endHour = 20 } = {}) {
  const local = zonedParts(date, timeZone);

  if (local.hour >= startHour && local.hour < endHour) return date;

  const day = Date.UTC(local.year, local.month - 1, local.day);
  const target = local.hour < startHour ? day : day + DAY_MS;
  const t = new Date(target);

  return zonedTimeToUtc(
    { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: startHour },
    timeZone
  );
}

/**
 * Cuándo debe salir un paso del embudo.
 * - `delayHours` (paso 1): registro + N horas, ajustado a la ventana.
 * - `delayDays` (pasos 2 a 4): misma hora local del registro, N días después, ajustada a la ventana.
 */
export function scheduleStep({ createdAt, country, step, window }) {
  const timeZone = timezoneForCountry(country);
  const created = new Date(createdAt);

  if (step.delayHours != null) {
    return clampToSendWindow(new Date(created.getTime() + step.delayHours * HOUR_MS), timeZone, window);
  }

  const local = zonedParts(created, timeZone);
  const base = new Date(Date.UTC(local.year, local.month - 1, local.day + step.delayDays));
  const at = zonedTimeToUtc(
    {
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: base.getUTCDate(),
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    timeZone
  );

  return clampToSendWindow(at, timeZone, window);
}

export default {
  DEFAULT_TIMEZONE,
  COUNTRY_TIMEZONE,
  timezoneForCountry,
  zonedParts,
  zonedTimeToUtc,
  clampToSendWindow,
  scheduleStep,
};

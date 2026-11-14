import { log } from './logger.js';

const HTTPS_STATUS = 'File transfer is done using HTTPS';
const HTTPS_REQUIRED = 'MEGA_HTTPS_REQUIRED';

function httpsRequiredError(ctx) {
  const suffix = ctx ? ` (${ctx})` : '';
  const error = new Error(`No se pudo confirmar HTTPS en MEGA; no se inicia la transferencia${suffix}.`);
  error.code = HTTPS_REQUIRED;
  return error;
}

export function isMegaHttpsError(error) {
  return error?.code === HTTPS_REQUIRED;
}

/**
 * Confirma HTTPS en la sesión actual antes de permitir una transferencia.
 * MEGAcmd antiguo pierde esta configuración al cerrar sesión: no se cachea.
 * runCmd se inyecta para compartir el ejecutor del llamador sin crear ciclos.
 */
export async function ensureMegaHttps(runCmd, ctx = '') {
  const execute = (args) => runCmd('mega-https', args, {
    quiet: true,
    timeoutMs: 10_000,
    autoAcceptTerms: false,
  });
  const query = async () => {
    const result = await execute([]);
    const output = typeof result === 'string' ? result : (result?.out ?? result?.stdout ?? '');
    return String(output).trim();
  };

  try {
    if (await query() === HTTPS_STATUS) return;

    await execute(['on']);
    if (await query() !== HTTPS_STATUS) throw httpsRequiredError(ctx);

    log.info(`[MEGA-HTTPS][OK] HTTPS activado y verificado${ctx ? ` (${ctx})` : ''}.`);
  } catch (error) {
    if (isMegaHttpsError(error)) throw error;
    // La salida del comando puede contener datos sensibles; no se copia al error.
    throw httpsRequiredError(ctx);
  }
}

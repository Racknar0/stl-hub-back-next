import { encryptJson } from './cryptoUtils.js';
import { log } from './logger.js';

/**
 * Inicia sesión en MEGA utilizando un ticket de sesión en caché (si existe) 
 * con fallback automático a usuario y contraseña si expira o falla.
 * Si se usa la contraseña, extrae el nuevo ticket de sesión con 'mega-session' y lo actualiza en la DB.
 *
 * @param {object} prisma Instancia del PrismaClient del llamador.
 * @param {function} runCmd Función runCmd local del script llamador.
 * @param {number} accountId ID de la cuenta en base de datos.
 * @param {object} payload Payload desencriptado de credenciales.
 * @param {string} ctx Contexto de log para seguimiento.
 * @param {number} timeoutLogin Timeout para la llamada de login en ms (default 60000).
 * @returns {Promise<{ success: boolean, method: 'session' | 'password' }>}
 */
export async function loginWithSessionCache(prisma, runCmd, accountId, payload, ctx, timeoutLogin = 60000) {
  const loginCmd = 'mega-login';
  const logoutCmd = 'mega-logout';
  const sessionCmd = 'mega-session';

  if (!payload) {
    throw new Error(`[MEGA-SESSION-CACHE] Sin payload de credenciales para accountId=${accountId}`);
  }

  // 1. Intentar iniciar sesión usando el ticket de sesión en caché
  if (payload.type === 'session' && payload.session) {
    try {
      log.info(`[MEGA-SESSION-CACHE][TICKET] Intentando login con ticket para accId=${accountId} (${ctx})`);
      // Aseguramos que la sesión local esté limpia pero preservada en MEGA antes de re-autenticar
      try { 
        await runCmd(logoutCmd, ['--keep-session'], { quiet: true, timeoutMs: 15000 }); 
      } catch (err) {
        // Ignorar fallo de logout inicial
      }

      await runCmd(loginCmd, [payload.session], { quiet: true, timeoutMs: timeoutLogin });
      log.info(`[MEGA-SESSION-CACHE][TICKET][OK] Login exitoso con TICKET para accId=${accountId}`);
      return { success: true, method: 'session' };
    } catch (e) {
      log.warn(`[MEGA-SESSION-CACHE][TICKET][WARN] Falló login con ticket para accId=${accountId}: ${e.message.trim()}. Intentando fallback de contraseña...`);
    }
  }

  // 2. Fallback a inicio de sesión con usuario y contraseña
  if (!payload.username || !payload.password) {
    throw new Error(`[MEGA-SESSION-CACHE] Credenciales incompletas para accId=${accountId}`);
  }

  try {
    log.info(`[MEGA-SESSION-CACHE][PASSWORD] Intentando login con CONTRASEÑA para accId=${accountId} (${ctx})`);
    // Aseguramos que la sesión local esté limpia
    try { 
      await runCmd(logoutCmd, ['--keep-session'], { quiet: true, timeoutMs: 15000 }); 
    } catch (err) {
      // Ignorar fallo
    }

    await runCmd(loginCmd, [payload.username, payload.password], { quiet: true, timeoutMs: timeoutLogin });
    log.info(`[MEGA-SESSION-CACHE][PASSWORD][OK] Login exitoso con CONTRASEÑA para accId=${accountId}`);

    // 3. Capturar el nuevo ticket de sesión generado por MEGA
    log.info(`[MEGA-SESSION-CACHE][SESSION-GET] Obteniendo el nuevo ticket de sesión para accId=${accountId}`);
    const res = await runCmd(sessionCmd, [], { quiet: true, timeoutMs: 15000 });
    let ticket = (res.out || '').trim();

    // Extraer la cadena del ticket removiendo cualquier texto explicativo de MEGA
    const prefix = 'Your (secret) session is:';
    if (ticket.includes(prefix)) {
      ticket = ticket.split(prefix)[1].trim();
    } else if (ticket.includes(':')) {
      ticket = ticket.split(':').pop().trim();
    }

    if (ticket && !ticket.toLowerCase().includes('no active session')) {
      const updatedPayload = {
        ...payload,
        type: 'session',
        session: ticket
      };

      // Encriptar y actualizar las credenciales en la base de datos
      const enc = encryptJson(updatedPayload);
      await prisma.accountCredential.update({
        where: { accountId: Number(accountId) },
        data: {
          encData: enc.encData,
          encIv: enc.encIv,
          encTag: enc.encTag
        }
      });
      log.info(`[MEGA-SESSION-CACHE][DB-UPDATE][OK] Ticket de sesión actualizado en DB para accId=${accountId}`);
    } else {
      log.warn(`[MEGA-SESSION-CACHE][SESSION-GET][WARN] No se pudo obtener un ticket válido de mega-session.`);
    }

    return { success: true, method: 'password' };
  } catch (e) {
    log.error(`[MEGA-SESSION-CACHE][LOGIN-FAIL] Fallaron tanto el ticket como la contraseña para accId=${accountId}: ${e.message.trim()}`);
    throw e;
  }
}

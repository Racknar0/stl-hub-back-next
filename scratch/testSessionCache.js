import { PrismaClient } from '@prisma/client';
import { decryptToJson, encryptJson } from '../src/utils/cryptoUtils.js';
import { applyMegaProxy, listMegaProxies, clearMegaProxyIfSafe } from '../src/utils/megaProxy.js';
import { spawn, execSync } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Cargar variables de entorno
dotenv.config();

const prisma = new PrismaClient();

// CONFIGURACIÓN DE PRUEBA LOCAL:
// Cambiar a true si se quieren usar proxies; false para probar directamente sin proxy
const USE_PROXIES = false;

// Helper para pausar ejecución
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Función para probar la conectividad de un proxy usando curl.exe
function testProxyConnectivity(proxy) {
  try {
    const proxyUrlWithAuth = `http://${proxy.username}:${proxy.password}@${proxy.proxyUrl.replace('http://', '')}`;
    const stdout = execSync(`curl.exe -s -I -x ${proxyUrlWithAuth} https://mega.co.nz --connect-timeout 6`, { encoding: 'utf-8', timeout: 7000 });
    return stdout.includes('HTTP/');
  } catch (e) {
    return false;
  }
}

// Función para responder automáticamente a los términos de licencia de MEGA
function attachAutoAcceptTerms(child, label = 'MEGA') {
  const EOL = '\n';
  const ACCEPT_REGEXES = [
    /Do you accept\s+these\s+terms\??/i,
    /Do you accept.*terms\??/i,
    /Type '\s*yes\s*' to continue/i,
    /Acepta[s]? .*t[ée]rminos\??/i,
    /¿Acepta[s]? los t[ée]rminos\??/i,
  ];
  const PROMPT_YNA = /Please enter \[y\]es\/\[n\]o\/\[a\]ll\/none|\[(y|Y)\]es\s*\/\s*\[(n|N)\]o\s*\/\s*\[(a|A)\]ll/i;
  const PROMPT_YN = /\[(y|Y)\]es\s*\/\s*\[(n|N)\]o/i;
  const PROMPT_ES_SN = /\[(s|S)\]\s*\/\s*\[(n|N)\]/i;

  const maybeAnswer = (s) => {
    try {
      if (ACCEPT_REGEXES.some(r => r.test(s))) {
        console.log(`[${label}][AUTO-PROMPT] Detectado prompt de términos. Respondiendo 'yes'...`);
        child.stdin.write('yes' + EOL);
      } else if (PROMPT_YNA.test(s)) {
        console.log(`[${label}][AUTO-PROMPT] Detectado prompt Y/N/A. Respondiendo 'a'...`);
        child.stdin.write('a' + EOL);
      } else if (PROMPT_YN.test(s)) {
        console.log(`[${label}][AUTO-PROMPT] Detectado prompt Y/N. Respondiendo 'y'...`);
        child.stdin.write('y' + EOL);
      } else if (PROMPT_ES_SN.test(s)) {
        console.log(`[${label}][AUTO-PROMPT] Detectado prompt S/N. Respondiendo 's'...`);
        child.stdin.write('s' + EOL);
      }
    } catch (e) {
      console.warn(`[${label}][AUTO-PROMPT][WARN] Falló auto-responder: ${e.message}`);
    }
  };

  if (!child?.stdout || !child?.stderr) return;
  child.stdout.on('data', d => maybeAnswer(d.toString()));
  child.stderr.on('data', d => maybeAnswer(d.toString()));
}

// Helper para ejecutar comandos imprimiendo logs en tiempo real
function runCmd(cmd, args = [], { timeoutMs = 45000 } = {}) {
  // Enmascarar la contraseña en los logs de la consola
  const isLogin = cmd.includes('mega-login');
  const loggedArgs = isLogin && args.length >= 2 ? [args[0], '******'] : args;
  
  console.log(`[CMD-EXEC] Ejecutando: ${cmd} ${loggedArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: true });
    
    // Autoaceptar términos de MEGAcmd si aparecen
    attachAutoAcceptTerms(child, cmd.toUpperCase());

    let out = '', err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      
      const errorMsg = `\n[CMD-TIMEOUT] ${cmd} excedió el timeout de ${timeoutMs}ms.\n` +
                       `--- stdout acumulado ---\n${out}\n` +
                       `--- stderr acumulado ---\n${err}\n`;
      reject(new Error(errorMsg));
    }, timeoutMs);

    child.stdout.on('data', d => {
      const chunk = d.toString();
      out += chunk;
      // Mostrar la salida de MEGAcmd en tiempo real para diagnóstico
      process.stdout.write(`  [stdout]: ${chunk}`);
    });

    child.stderr.on('data', d => {
      const chunk = d.toString();
      err += chunk;
      process.stderr.write(`  [stderr]: ${chunk}`);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ out, err });
      else {
        const errorMsg = `Comando ${cmd} falló con código ${code}.\n` +
                         `--- stdout ---\n${out}\n` +
                         `--- stderr ---\n${err}\n`;
        reject(new Error(errorMsg));
      }
    });

    child.on('error', e => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

// Logica de login con gestión del caché de ticket de sesión
async function loginToMegaWithSessionCache(accountId, payload, ctx) {
  const loginCmd = 'mega-login';
  const logoutCmd = 'mega-logout';
  const sessionCmd = 'mega-session';

  if (!payload) throw new Error('No credentials payload provided');

  // 1. Intentar login con ticket de sesión si existe
  if (payload.type === 'session' && payload.session) {
    try {
      console.log(`\n[PRUEBA][SESSION] intentando login con TICKET DE SESIÓN para ID=${accountId} (${ctx})`);
      // Asegurar que no hay sesión activa en el daemon
      try { await runCmd(logoutCmd, ['--keep-session'], { timeoutMs: 15000 }); } catch {}
      
      await runCmd(loginCmd, [payload.session], { timeoutMs: 45000 });
      console.log(`[PRUEBA][SESSION][OK] ¡Conectado con TICKET DE SESIÓN! (Sin usar contraseña)`);
      return { success: true, method: 'session' };
    } catch (e) {
      console.warn(`[PRUEBA][SESSION][WARN] Falló el login con ticket: ${e.message.trim()}. Usando fallback de contraseña...`);
    }
  }

  // 2. Fallback a login con usuario y contraseña
  if (!payload.username || !payload.password) {
    throw new Error('Credenciales incompletas en el payload');
  }

  try {
    console.log(`[PRUEBA][PASSWORD] intentando login con CONTRASEÑA para ID=${accountId} (${ctx})`);
    // Asegurar que no hay sesión activa en el daemon
    try { await runCmd(logoutCmd, ['--keep-session'], { timeoutMs: 15000 }); } catch {}

    await runCmd(loginCmd, [payload.username, payload.password], { timeoutMs: 45000 });
    console.log(`[PRUEBA][PASSWORD][OK] Conectado con CONTRASEÑA.`);

    // 3. Obtener el ticket de sesión generado por MEGA
    console.log(`[PRUEBA][SESSION] Obteniendo el nuevo ticket de sesión desde MEGA...`);
    const res = await runCmd(sessionCmd, [], { timeoutMs: 15000 });
    let ticket = res.out.trim();

    // Extraer solo la cadena del ticket de sesión si viene precedida por el texto informativo de MEGA
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
      
      // Encriptar y actualizar en la DB
      const enc = encryptJson(updatedPayload);
      await prisma.accountCredential.update({
        where: { accountId: Number(accountId) },
        data: {
          encData: enc.encData,
          encIv: enc.encIv,
          encTag: enc.encTag
        }
      });
      console.log(`[PRUEBA][DB-UPDATE][OK] Nuevo ticket de sesión guardado en la base de datos para ID=${accountId}`);
    } else {
      console.warn(`[PRUEBA][SESSION][WARN] No se obtuvo un ticket de sesión válido.`);
    }

    return { success: true, method: 'password' };
  } catch (e) {
    console.error(`[PRUEBA][LOGIN][ERROR] Falló el login con contraseña para ID=${accountId}: ${e.message.trim()}`);
    throw e;
  }
}

// Función principal de prueba
async function runTest() {
  console.log('==================================================================');
  console.log('  INICIANDO SCRIPT DE PRUEBA: CACHÉ DE TICKETS DE SESIÓN MEGA     ');
  console.log('==================================================================');

  // 1. Cargar proxies (solo si USE_PROXIES es true)
  let workingProxies = [];
  if (USE_PROXIES) {
    const rawProxies = listMegaProxies({ shuffle: false });
    if (!rawProxies.length) {
      console.error('ERROR: No hay proxies configurados en proxies.txt. Abortando.');
      process.exit(1);
    }
    console.log(`Cargados ${rawProxies.length} proxies en total. Evaluando conectividad para encontrar proxies funcionales...`);

    for (const proxy of rawProxies) {
      process.stdout.write(`Probando proxy: ${proxy.proxyUrl}... `);
      if (testProxyConnectivity(proxy)) {
        console.log('FUNCIONAL [OK]');
        workingProxies.push(proxy);
        if (workingProxies.length >= 4) break;
      } else {
        console.log('NO DISPONIBLE / TIMEOUT [X]');
      }
    }

    if (!workingProxies.length) {
      console.error('ERROR: No se encontraron proxies funcionales en proxies.txt. Abortando.');
      process.exit(1);
    }
    console.log(`Seleccionados ${workingProxies.length} proxies funcionales para la ejecución de la prueba.`);
  } else {
    console.log('[TEST] Ejecutando sin proxies. Se usará la conexión directa a Internet.');
  }

  // 2. Obtener 4 cuentas activas con credenciales en la DB para la prueba
  const dbAccounts = await prisma.megaAccount.findMany({
    where: { suspended: false, credentials: { isNot: null } },
    take: 4,
    include: { credentials: true }
  });

  if (dbAccounts.length < 4) {
    console.error(`ERROR: Se necesitan al menos 4 cuentas activas con credenciales en la base de datos. Solo se encontraron ${dbAccounts.length}.`);
    process.exit(1);
  }

  console.log(`Seleccionadas 4 cuentas para el test:`);
  dbAccounts.forEach((acc, i) => {
    console.log(`  Cuenta ${i + 1}: ID=${acc.id} Alias=${acc.alias} Email=${acc.email}`);
  });

  // Limpiar sesión y proxy al inicio de todo
  try { await runCmd('mega-logout', [], { timeoutMs: 15000 }); } catch {}
  try {
    if (USE_PROXIES) {
      await clearMegaProxyIfSafe();
    } else {
      await runCmd('mega-proxy', ['--none'], { quiet: true, timeoutMs: 8000 });
    }
  } catch {}

  // ------------------------------------------------------------------
  // ESCENARIO 1: SIMULACIÓN DE VALIDADOR DIARIO (Revisión de Métricas)
  // ------------------------------------------------------------------
  console.log('\n------------------------------------------------------------------');
  console.log(' ESCENARIO 1: SIMULACIÓN DE VALIDADOR DIARIO (Cuenta 1 y 2)');
  console.log('------------------------------------------------------------------');

  const validatorAccounts = [dbAccounts[0], dbAccounts[1]];

  for (let i = 0; i < validatorAccounts.length; i++) {
    const acc = validatorAccounts[i];
    const ctx = `Validador-Run1-Acc${acc.id}`;
    
    // Asignar proxy si está habilitado
    if (USE_PROXIES) {
      const proxy = workingProxies[i % workingProxies.length];
      console.log(`\n[TEST] Aplicando proxy funcional (${proxy.proxyUrl}) para ID=${acc.id}`);
      await applyMegaProxy(proxy, { ctx, timeoutMs: 15000, clearOnFail: false });
    } else {
      console.log(`\n[TEST] Conexión directa (sin proxy) para ID=${acc.id}`);
    }

    // Desencriptar credenciales originales
    const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag);
    
    // Forzar a limpiar ticket si existía antes del test para asegurar que use contraseña al inicio
    const testPayload = { ...payload, type: 'login', session: undefined };

    // Primer Login (Debería usar contraseña y capturar el ticket)
    const result1 = await loginToMegaWithSessionCache(acc.id, testPayload, ctx);
    console.log(`Resultado: método=${result1.method}`);

    // Simular lectura de datos rápida
    console.log(`[TEST] Obteniendo nombre de usuario activo (whoami)...`);
    const who = await runCmd('mega-whoami', [], { timeoutMs: 15000 });
    console.log(`Resultado whoami: ${who.out.trim()}`);

    // Desconectar con --keep-session para conservar el ticket en MEGA
    console.log(`[TEST] Desconectando con --keep-session...`);
    await runCmd('mega-logout', ['--keep-session'], { timeoutMs: 15000 });
  }

  // Simular paso del tiempo / gap entre revisiones (pausa de 3 segundos)
  console.log('\n[TEST] Simulando paso de tiempo (espera de 3 segundos)...');
  await sleep(3000);

  console.log('\n>>> RE-VALIDACIÓN: Segunda vuelta del Validador Diario <<<');
  for (let i = 0; i < validatorAccounts.length; i++) {
    const acc = validatorAccounts[i];
    const ctx = `Validador-Run2-Acc${acc.id}`;

    // Asignar el mismo proxy funcional si está habilitado
    if (USE_PROXIES) {
      const proxy = workingProxies[i % workingProxies.length];
      await applyMegaProxy(proxy, { ctx, timeoutMs: 15000, clearOnFail: false });
    } else {
      console.log(`\n[TEST] Conexión directa (sin proxy) para ID=${acc.id}`);
    }

    // Cargar credenciales actualizadas (que ahora deben contener el ticket guardado)
    const updatedAcc = await prisma.megaAccount.findUnique({
      where: { id: acc.id },
      include: { credentials: true }
    });
    const payload = decryptToJson(updatedAcc.credentials.encData, updatedAcc.credentials.encIv, updatedAcc.credentials.encTag);

    // Segundo Login (Debería reutilizar el ticket de sesión)
    const result2 = await loginToMegaWithSessionCache(acc.id, payload, ctx);
    console.log(`Resultado: método=${result2.method}`);
    if (result2.method === 'session') {
      console.log(`[OK] ¡TEST PASADO! Se reutilizó la sesión correctamente sin contraseña.`);
    } else {
      console.error(`[ERROR] Se esperaba usar 'session' pero se usó '${result2.method}'`);
    }

    // Desconectar
    await runCmd('mega-logout', ['--keep-session'], { timeoutMs: 15000 });
  }


  // ------------------------------------------------------------------
  // ESCENARIO 2: SIMULACIÓN DE BATCH UPLOADER (Rotación Rápida)
  // ------------------------------------------------------------------
  console.log('\n------------------------------------------------------------------');
  console.log(' ESCENARIO 2: SIMULACIÓN DE BATCH UPLOADER (Rotación de 4 cuentas)');
  console.log('------------------------------------------------------------------');

  // Inicializar tickets para las 4 cuentas primero (si no tienen)
  console.log('\n>>> Paso 1: Asegurando tickets de sesión válidos para las 4 cuentas...');
  for (let i = 0; i < dbAccounts.length; i++) {
    const acc = dbAccounts[i];
    const ctx = `Batch-Prep-Acc${acc.id}`;
    if (USE_PROXIES) {
      const proxy = workingProxies[i % workingProxies.length];
      await applyMegaProxy(proxy, { ctx });
    }

    const updatedAcc = await prisma.megaAccount.findUnique({ where: { id: acc.id }, include: { credentials: true } });
    const payload = decryptToJson(updatedAcc.credentials.encData, updatedAcc.credentials.encIv, updatedAcc.credentials.encTag);
    
    // Si no tiene session ticket, se loguea y lo guarda
    await loginToMegaWithSessionCache(acc.id, payload, ctx);
    await runCmd('mega-logout', ['--keep-session'], { timeoutMs: 15000 });
  }

  console.log('\n>>> Paso 2: Rotación rápida del Batch Uploader usando Session Tickets...');
  const order = [0, 1, 2, 3, 0, 1, 2, 3]; // Rotamos dos vueltas completas

  for (let step = 0; step < order.length; step++) {
    const index = order[step];
    const acc = dbAccounts[index];
    const ctx = `Batch-Step${step}-Acc${acc.id}`;

    if (USE_PROXIES) {
      const proxy = workingProxies[index % workingProxies.length];
      console.log(`\n[BATCH-ROTATION] Paso ${step + 1}: Cambiando a Cuenta ID=${acc.id} Alias=${acc.alias}`);
      await applyMegaProxy(proxy, { ctx, timeoutMs: 15000, clearOnFail: false });
    } else {
      console.log(`\n[BATCH-ROTATION] Paso ${step + 1}: Cambiando a Cuenta ID=${acc.id} Alias=${acc.alias} (conexión directa)`);
    }

    // Cargar credenciales
    const updatedAcc = await prisma.megaAccount.findUnique({ where: { id: acc.id }, include: { credentials: true } });
    const payload = decryptToJson(updatedAcc.credentials.encData, updatedAcc.credentials.encIv, updatedAcc.credentials.encTag);

    // Login (Debería ser 100% de tipo 'session')
    const startTs = Date.now();
    const loginResult = await loginToMegaWithSessionCache(acc.id, payload, ctx);
    const duration = Date.now() - startTs;
    console.log(`[BATCH-ROTATION] Login completado in ${duration}ms via método=${loginResult.method}`);

    if (loginResult.method !== 'session') {
      console.warn(`[PRUEBA][WARN] Cuenta ID=${acc.id} no usó sesión. Usó contraseña. Puede deberse a expiración legítima.`);
    }

    // Desconectar con --keep-session para rotar
    await runCmd('mega-logout', ['--keep-session'], { timeoutMs: 15000 });
  }

  // ------------------------------------------------------------------
  // LIMPIEZA FINAL
  // ------------------------------------------------------------------
  console.log('\n------------------------------------------------------------------');
  console.log(' LIMPIEZA Y CIERRE DEL TEST');
  console.log('------------------------------------------------------------------');
  try {
    console.log('Desconectando sesión final...');
    await runCmd('mega-logout', [], { timeoutMs: 15000 });
    if (USE_PROXIES) {
      console.log('Limpiando proxies...');
      await clearMegaProxyIfSafe();
    } else {
      await runCmd('mega-proxy', ['--none'], { quiet: true, timeoutMs: 8000 });
    }
  } catch (e) {}

  console.log('\n==================================================================');
  console.log('                 FIN DE LAS PRUEBAS DE CACHÉ                      ');
  console.log('==================================================================');
}

runTest().catch(err => {
  console.error('Ocurrió un error fatal ejecutando el test:', err);
}).finally(async () => {
  await prisma.$disconnect();
});

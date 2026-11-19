// server.js
import http from 'http';
import dns from 'dns';
import app from './app.js';
import { startBatchWorker } from './src/workers/batchWorker.js';
import pinterestWorker from './src/services/pinterestWorker.service.js';
import { startAutopilotScheduler } from './src/services/pinterestAutopilot.service.js';
import { startReelsWorker } from './src/services/reels.service.js';
import { startSnapshotScheduler } from './src/services/socialMetrics.service.js';
import { startEmailEngine } from './src/services/emailEngine.service.js';
import { startReengageCloser } from './src/services/emailReengage.service.js';
import telegramCheckerService from './src/services/telegramChecker.service.js';
import telegramDownloaderService from './src/services/telegramDownloader.service.js';
import { resumeInterruptedDownloads } from './src/controllers/telegramDownloader.controller.js';

// Preferir IPv4 al conectar con servicios externos: desde la IPv6 del VPS (Contabo) Google rechaza la API de Gemini
// con "User location is not supported", mientras que por IPv4 funciona.
dns.setDefaultResultOrder('ipv4first');

const PORT = process.env.PORT || 3001; // usa 3001 si NGINX proxy_pass -> 3001

const server = http.createServer(app);

// ---- Timeouts para uploads grandes / SSE ----
server.requestTimeout = 0;        // sin límite de tiempo de request
server.headersTimeout = 0;        // sin límite para headers
server.keepAliveTimeout = 75_000; // 75s para keep-alive

server.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
  // Iniciar worker de batches en segundo plano sin bloquear
  setTimeout(() => {
    startBatchWorker().catch(e => console.error('Worker fail:', e));
  }, 3000);

  // Iniciar worker de Pinterest
  setTimeout(() => {
    pinterestWorker.start(60000); // Revisa la cola cada 1 minuto
    startReelsWorker(60000); // Publica los reels aprobados cuando llega su hora (real o simulado según el ajuste)
    startSnapshotScheduler(); // Foto de las métricas de las redes cada 6 h (historial del panel Redes)
    startAutopilotScheduler(); // Piloto automático: prepara los pines de mañana una vez al día (si está activado)
  }, 5000);

  // Motor de correos propio (nace apagado: sin EMAIL_ENGINE_ENABLED=true solo planifica)
  setTimeout(() => {
    startEmailEngine();
    startReengageCloser(); // Cierra el reenganche de quien no reaccionó en el plazo
  }, 9000);

  // Retomar la descarga de Telegram que quedó a medias por un reinicio (antes del Auto-Checker, que espera si hay descarga)
  setTimeout(() => {
    resumeInterruptedDownloads();
  }, 4000);

  // Iniciar worker de Telegram Auto-Checker
  setTimeout(() => {
    telegramCheckerService.start();
  }, 7000);
});

// Apagado ordenado (pm2 restart / u_back): se guarda el avance de la descarga de Telegram en curso
// para que el próximo arranque la retome donde iba, en vez de perderla.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await telegramDownloaderService.prepareShutdown();
    } catch (e) {
      console.error('Error guardando la descarga de Telegram al apagar:', e.message);
    }
    process.exit(0);
  });
}

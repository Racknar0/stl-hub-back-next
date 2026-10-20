// server.js
import http from 'http';
import app from './app.js';
import { startBatchWorker } from './src/workers/batchWorker.js';
import pinterestWorker from './src/services/pinterestWorker.service.js';
import { startAutopilotScheduler } from './src/services/pinterestAutopilot.service.js';
import { startReelsWorker } from './src/services/reels.service.js';
import telegramCheckerService from './src/services/telegramChecker.service.js';

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
    startAutopilotScheduler(); // Piloto automático: prepara los pines de mañana una vez al día (si está activado)
  }, 5000);

  // Iniciar worker de Telegram Auto-Checker
  setTimeout(() => {
    telegramCheckerService.start();
  }, 7000);
});
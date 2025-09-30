// server.js
import http from 'http';
import app from './app.js';

const PORT = process.env.PORT || 3001; // usa 3001 si NGINX proxy_pass -> 3001

const server = http.createServer(app);

// ---- Timeouts para uploads grandes / SSE ----
server.requestTimeout = 0;        // sin límite de tiempo de request
server.headersTimeout = 0;        // sin límite para headers
server.keepAliveTimeout = 75_000; // 75s para keep-alive

server.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
});
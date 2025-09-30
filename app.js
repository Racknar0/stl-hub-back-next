// app.js
import express from 'express';
import routes from './src/routes/index.js';
import { installConsoleHook, logsSSEHandler } from './src/utils/logStream.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './src/utils/logger.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api', routes);

// Hook de consola (una sola vez)
installConsoleHook();

// Endpoint SSE para logs
app.get('/api/logs/stream', logsSSEHandler);

console.log('CWD---------:', process.cwd());

// 👇 Importante: NO app.listen aquí
export default app;

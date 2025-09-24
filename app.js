import express from 'express';
import routes from './src/routes/index.js';
import { installConsoleHook, logsSSEHandler } from './src/utils/logStream.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './src/utils/logger.js';

const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors()); // Para permitir peticiones desde cualquier origen

app.use(express.json()); // para interpretar los datos que vienen en el body de las peticiones
app.use(express.urlencoded({ extended: true })); // Para interpretar datos de formularios (x-www-form-urlencoded)

// Servir archivos subidos (imágenes, etc.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api', routes);

// Hook de consola (una sola vez)
installConsoleHook();

// Endpoint SSE para logs
app.get('/api/logs/stream', logsSSEHandler);


app.listen(PORT, () => {
    log.info(`Servidor iniciado en http://localhost:${PORT}/api`);
});
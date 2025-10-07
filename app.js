// app.js
import express from 'express';
import routes from './src/routes/index.js';
import { unless } from './src/helpers/removeParsersBoady.js';
import { installConsoleHook, logsSSEHandler } from './src/utils/logStream.js';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './src/utils/logger.js';

const app = express();

app.use(cors());
// No aplicar parsers JSON/urlencoded cuando el request es multipart/form-data (cualquier ruta).
// En algunos despliegues (p.ej., NGINX) la URL puede reescribirse y el matcher por ruta deja de coincidir.
// Detectar por Content-Type es más robusto y evita conflictos con Multer, mejorando el rendimiento de uploads.
const isMultipart = (req) => {
	try {
		const ct = req.headers['content-type'] || '';
		return /multipart\/form-data/i.test(ct);
	} catch {
		return false;
	}
};
app.use(unless(isMultipart, express.json()));
app.use(unless(isMultipart, express.urlencoded({ extended: true })));

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

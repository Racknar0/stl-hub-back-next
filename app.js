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

// CORS robusto: permitir orígenes configurables y manejar preflight
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
	origin: (origin, callback) => {
		// Permitir sin Origin (p.ej. curl) o si no se configuró whitelist
		if (!origin || allowedOrigins.length === 0) return callback(null, true);
		// Coincidencia exacta
		if (allowedOrigins.includes(origin)) return callback(null, true);
		// Permitir subdominios si están definidos como *.dominio
		const ok = allowedOrigins.some(o => o.startsWith('*.') && origin.endsWith(o.slice(1)));
		if (ok) return callback(null, true);
		return callback(new Error('CORS: Origin no permitido: ' + origin), false);
	},
	credentials: true,
	methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
	allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
	exposedHeaders: ['Content-Length'],
	optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
	// Ayuda a caches/CDN a variar por origen
	res.setHeader('Vary', 'Origin');
	next();
});
app.use(cors(corsOptions));
// Asegurar manejo de preflight, incluso si NGINX reenvía OPTIONS
app.options('*', cors(corsOptions));
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

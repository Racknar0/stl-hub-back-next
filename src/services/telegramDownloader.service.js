import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger } from 'telegram/extensions/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { getFileInfo } from 'telegram/Utils.js';
import bigInt from 'big-integer';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { bytesFromDone, clearPartState, loadPartState, savePartState } from '../utils/telegramPartState.js';

const prisma = new PrismaClient();

// Api ID and Hash for the client
const apiId = 32505903;
const apiHash = 'c99427986581742a5cefcfe990e9884a';

const SESSION_PATH = path.join(process.cwd(), 'data', 'telegram.session');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'telegram_downloads');
const LAST_DOWNLOADS_PATH = path.join(process.cwd(), 'data', 'last_downloads.json');

const FAST_DOWNLOAD_MIN_BYTES = 20 * 1024 * 1024;
const FAST_WORKERS = 4;
const FAST_PART_SIZE_KB = 512;
const PART_STATE_SAVE_EVERY_MS = 2000; // cada cuánto se guarda el avance de un archivo grande
const MAX_AUTO_RESUMES = 5;            // tope de reanudaciones automáticas de una misma descarga
// Cortacircuitos: gramJS a veces entra en un bucle de reconexión de miles de intentos por segundo
// que satura la CPU y la salida estándar hasta dejar colgado todo el backend (20-nov-2026).
const RECONNECT_STORM_WINDOW_MS = 10000; // ventana en la que se cuentan las reconexiones
const RECONNECT_STORM_MAX = 30;          // más reconexiones que esto en la ventana = tormenta
const RECONNECT_LOG_EVERY_MS = 5000;     // como mucho una línea de reconexión cada 5 s en el log

const RECONNECT_LOG_PREFIXES = [
    'Started reconnecting',
    '[Reconnect]',
    'Disconnecting from ',
    'WebSocket connection failed',
];

class FilteredLogger extends Logger {
    constructor(level, onReconnect) {
        super(level);
        this.onReconnect = onReconnect; // avisa al servicio de cada reconexión
        this.lastReconnectLog = 0;
        this.skippedReconnectLogs = 0;
    }

    log(level, message, color) {
        const msg = String(message ?? '');
        if (RECONNECT_LOG_PREFIXES.some((p) => msg.startsWith(p))) {
            if (msg.startsWith('Started reconnecting')) this.onReconnect?.();
            // Se resumen en vez de imprimir cada una: en un bucle llegan a miles por segundo.
            const now = Date.now();
            if (now - this.lastReconnectLog < RECONNECT_LOG_EVERY_MS) {
                this.skippedReconnectLogs++;
                return;
            }
            const skipped = this.skippedReconnectLogs;
            this.lastReconnectLog = now;
            this.skippedReconnectLogs = 0;
            return super.log(level, skipped ? `${msg} (+${skipped} líneas de reconexión omitidas)` : message, color);
        }
        if (level === LogLevel.INFO) {
            if (msg.startsWith('Sleeping for ')) return;
            if (msg.startsWith('Starting direct file download')) return;
            if (msg.startsWith('Starting indirect file download')) return;
            if (msg.startsWith('Connecting to ')) return;
            if (msg.startsWith('Connection to ')) return;
            if (msg.startsWith('Exporting authorization')) return;
        }
        return super.log(level, message, color);
    }
}

// ─── Errores del login de Telegram ─────────────────────────────────
// Código o contraseña equivocados: se vuelven a pedir sin reiniciar el login
const RETRYABLE_AUTH_ERRORS = new Set(['PHONE_CODE_INVALID', 'PHONE_CODE_EMPTY', 'PASSWORD_HASH_INVALID']);

// Dónde buscar el código según la respuesta de Telegram
function describeCodeDelivery(d) {
    if (!d?.type) return null;
    const len = d.length ? ` de ${d.length} dígitos` : '';
    const map = {
        App: `Telegram envió el código${len} a tu app de Telegram: abre el chat oficial "Telegram" (visto azul) en el celular o en Telegram Desktop.`,
        Sms: `Telegram envió el código${len} por SMS a tu número.`,
        SmsWord: 'Telegram envió por SMS una palabra como código.',
        SmsPhrase: 'Telegram envió por SMS una frase como código.',
        Call: `Telegram te va a llamar y dictará el código${len}.`,
        FlashCall: 'Telegram hará una llamada perdida: el código son los últimos dígitos del número que llama.',
        MissedCall: `Telegram hará una llamada perdida: el código son los últimos ${d.length || ''} dígitos del número que llama.`,
        EmailCode: `Telegram envió el código${len} a tu correo de inicio de sesión${d.emailPattern ? ` (${d.emailPattern})` : ''}. Revisa también spam.`,
        SetUpEmailRequired: 'Telegram exige configurar un correo de inicio de sesión antes de enviar el código. Configúralo en la app (Ajustes → Privacidad y seguridad → Correo de inicio de sesión) y vuelve a empezar.',
        FragmentSms: 'Telegram envió el código a tu número anónimo de Fragment (revísalo en fragment.com).',
        FirebaseSms: 'Telegram envió el código por SMS (verificación de Firebase).',
    };
    return map[d.type] || `Telegram envió el código por: ${d.type}.`;
}

function describeAuthError(code) {
    if (!code) return null;
    const map = {
        PASSWORD_HASH_INVALID: 'Contraseña de verificación en dos pasos incorrecta. Es la contraseña que configuraste en Telegram (Ajustes → Privacidad y seguridad → Verificación en dos pasos), no el código.',
        PHONE_CODE_INVALID: 'Código incorrecto. Revisa el código que te llegó por Telegram o SMS.',
        PHONE_CODE_EMPTY: 'Falta el código.',
        PHONE_CODE_EXPIRED: 'El código expiró. Vuelve a empezar para pedir uno nuevo.',
        PHONE_NUMBER_INVALID: 'Número de teléfono inválido. Usa el formato internacional, p. ej. +573001234567.',
        PHONE_NUMBER_BANNED: 'Telegram bloqueó este número.',
        PHONE_NUMBER_UNOCCUPIED: 'Ese número no tiene cuenta de Telegram.',
        SESSION_PASSWORD_NEEDED: 'La cuenta tiene verificación en dos pasos: escribe su contraseña.',
        AUTH_USER_CANCEL: 'El inicio de sesión se canceló. Vuelve a empezar.',
    };
    if (map[code]) return map[code];
    const flood = String(code).match(/FLOOD_WAIT_(\d+)|A wait of (\d+) seconds/i);
    if (flood) {
        const secs = Number(flood[1] || flood[2]);
        return `Telegram pide esperar ${secs >= 60 ? Math.ceil(secs / 60) + ' min' : secs + ' s'} antes de reintentar (demasiados intentos).`;
    }
    return `Error de Telegram: ${code}`;
}

class TelegramDownloaderService {
    constructor() {
        this.client = null;
        this.isDownloading = false;
        this.shouldCancel = false;
        this.shuttingDown = false;  // el backend se está apagando: se conserva el avance para retomar
        this.currentJobId = null;   // fila de TelegramDownloadJob de la descarga en curso
        this.flushPartState = null; // guarda ya el avance del archivo grande que se está bajando
        this.progressEmitter = null; // Callback for SSE
        this.reconnectTimes = [];    // momentos de las últimas reconexiones de gramJS
        this.reconnectStorm = false; // se cortó el cliente por un bucle de reconexión

        // Auth flow resolvers
        this.resolvePhoneCode = null;
        this.resolvePassword = null;
        this.authError = null;
        this.isAuthenticating = false;
        this.authStage = 'idle';    // idle | sending | code | password | done | failed (lo lee la pantalla de login)
        this.passwordHint = null;   // pista de la contraseña 2FA que devuelve Telegram
        this.authGeneration = 0;    // cada intento nuevo invalida al anterior
        this.codeDelivery = null;   // por dónde mandó Telegram el código: { type, emailPattern, length, nextType, timeout }
        
        // Persistent state for reconnecting clients
        this.lastProgress = null;   // Last progress event
        this.logBuffer = [];        // Last N log events
        this.downloadInfo = null;   // { channelName, startId, endId, startedAt }
        
        if (!fs.existsSync(UPLOADS_DIR)) {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        }
    }

    // Cuenta una reconexión de gramJS; si hay demasiadas seguidas, destruye el cliente y corta la descarga
    // (queda como fallida para que el reintento automático la retome con un cliente nuevo).
    noteReconnect() {
        if (this.reconnectStorm) return;
        const now = Date.now();
        this.reconnectTimes.push(now);
        while (this.reconnectTimes.length && now - this.reconnectTimes[0] > RECONNECT_STORM_WINDOW_MS) {
            this.reconnectTimes.shift();
        }
        if (this.reconnectTimes.length <= RECONNECT_STORM_MAX) return;

        this.reconnectStorm = true;
        this.reconnectTimes = [];
        console.error(`[Telegram Downloader] Bucle de reconexión (${RECONNECT_STORM_MAX}+ en ${RECONNECT_STORM_WINDOW_MS / 1000} s): se destruye el cliente de Telegram.`);
        this.shouldCancel = true;
        try { this.flushPartState?.(); } catch {}
        const client = this.client;
        this.client = null;
        if (client) {
            Promise.resolve()
                .then(() => client.destroy())
                .catch((e) => console.error('[Telegram Downloader] Error al destruir el cliente:', e?.message || e));
        }
    }

    newLogger() {
        return new FilteredLogger(LogLevel.INFO, () => this.noteReconnect());
    }

    async checkAuth() {
        // Solo verificamos si existe el archivo de sesión con contenido válido.
        // No intentamos conectar aquí para evitar bloqueos por FLOOD.
        if (!fs.existsSync(SESSION_PATH)) return false;
        const content = fs.readFileSync(SESSION_PATH, 'utf8').trim();
        return content.length > 10; // Una sesión válida tiene más de 10 chars
    }

    async logout() {
        if (this.client) {
            try { await this.client.disconnect(); } catch {}
            this.client = null;
        }
        if (fs.existsSync(SESSION_PATH)) {
            fs.unlinkSync(SESSION_PATH);
        }
    }

    clearDownloads() {
        if (!fs.existsSync(UPLOADS_DIR)) return 0;
        const files = fs.readdirSync(UPLOADS_DIR);
        let count = 0;
        for (const file of files) {
            if (file === '.gitkeep') continue;
            const filePath = path.join(UPLOADS_DIR, file);
            try {
                fs.rmSync(filePath, { recursive: true, force: true });
                count++;
            } catch (err) {
                console.error(`[Clear Downloads] No se pudo eliminar ${file}:`, err.message);
            }
        }
        return count;
    }

    async startAuth(phoneNumber) {
        // Un intento anterior abandonado (p. ej. se cerró la página) ya no bloquea: se descarta
        if (this.isAuthenticating && this.client) {
            try { await this.client.disconnect(); } catch {}
        }
        const generation = ++this.authGeneration;
        const current = () => generation === this.authGeneration;

        this.isAuthenticating = true;
        this.authError = null;
        this.authStage = 'sending';
        this.passwordHint = null;
        this.codeDelivery = null;
        this.resolvePhoneCode = null;
        this.resolvePassword = null;

        const stringSession = new StringSession("");
        const baseLogger = this.newLogger();
        const client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 1,   // Solo 1 reintento para evitar FLOOD
            retryDelay: 5000,
            useWSS: false,
            baseLogger
        });
        this.client = client;

        // GramJS no expone por dónde se envió el código (app, SMS, correo…): se lee de la respuesta auth.SentCode
        const originalInvoke = client.invoke.bind(client);
        client.invoke = async (request, ...rest) => {
            const result = await originalInvoke(request, ...rest);
            if (current() && result?.className === 'auth.SentCode') {
                this.codeDelivery = {
                    type: String(result.type?.className || '').replace('auth.SentCodeType', ''),
                    emailPattern: result.type?.emailPattern || null,
                    length: result.type?.length || null,
                    nextType: result.nextType ? String(result.nextType.className || '').replace('auth.CodeType', '') : null,
                    timeout: result.timeout || null,
                };
                console.log('[Telegram Auth] Código enviado por:', JSON.stringify(this.codeDelivery));
            }
            return result;
        };

        // Este proceso corre en background y espera a que resuelvas las promesas
        client.start({
            phoneNumber: async () => phoneNumber,
            password: async (hint) => new Promise(resolve => {
                if (!current()) return;
                this.authStage = 'password';
                this.passwordHint = hint || null;
                this.resolvePassword = resolve;
            }),
            phoneCode: async () => new Promise(resolve => {
                if (!current()) return;
                this.authStage = 'code';
                this.resolvePhoneCode = resolve;
            }),
            onError: (err) => {
                if (!current()) return true;
                const code = err?.errorMessage || err?.message || String(err);
                console.error("Auth Error:", err);
                this.authError = code;
                // Código o contraseña equivocados: GramJS vuelve a pedirlos (no se reinicia todo el login)
                return !RETRYABLE_AUTH_ERRORS.has(code);
            },
        }).then(() => {
            if (!current()) return;
            const sessionStr = client.session.save();
            if (!fs.existsSync(path.dirname(SESSION_PATH))) {
                fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
            }
            fs.writeFileSync(SESSION_PATH, sessionStr, 'utf8');
            this.authStage = 'done';
            this.authError = null;
            console.log('Telegram session saved to data/telegram.session');
        }).catch(err => {
            if (!current()) return;
            // AUTH_USER_CANCEL lo lanza GramJS tras un error no recuperable: se conserva ese error original
            if (!this.authError || err.message !== 'AUTH_USER_CANCEL') this.authError = err.message;
            this.authStage = 'failed';
            console.error("Auth final error:", err.message);
        }).finally(() => {
            if (current()) this.isAuthenticating = false;
        });
    }

    provideCode(code) {
        if (!this.resolvePhoneCode) return false;
        this.authError = null;
        this.authStage = 'sending';
        this.resolvePhoneCode(String(code).trim());
        this.resolvePhoneCode = null;
        return true;
    }

    providePassword(password) {
        if (!this.resolvePassword) return false;
        this.authError = null;
        this.authStage = 'sending';
        this.resolvePassword(password);
        this.resolvePassword = null;
        return true;
    }

    // Estado del login para la pantalla: en qué paso está y el último error de Telegram
    getAuthState() {
        return {
            stage: this.authStage,
            authenticating: this.isAuthenticating,
            error: this.authError,
            errorMessage: describeAuthError(this.authError),
            passwordHint: this.authStage === 'password' ? this.passwordHint : null,
            codeDelivery: this.codeDelivery,
            codeDeliveryMessage: describeCodeDelivery(this.codeDelivery),
        };
    }

    async initClient() {
        const checkAuthWithTimeout = async () => {
            if (!this.client) return false;
            try {
                return await Promise.race([
                    this.client.checkAuthorization(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 5000))
                ]);
            } catch (err) {
                console.log('checkAuthorization timeout/error, recreating client...');
                try { await this.client.disconnect(); } catch (e) {}
                this.client = null;
                return false;
            }
        };

        if (await checkAuthWithTimeout()) return;

        let existingSession = '';
        if (fs.existsSync(SESSION_PATH)) {
            existingSession = fs.readFileSync(SESSION_PATH, 'utf8').trim();
        } else if (process.env.TELEGRAM_SESSION) {
            existingSession = process.env.TELEGRAM_SESSION;
        }

        if (!existingSession) {
            throw new Error('No hay sesión de Telegram guardada. Debes autenticarte primero.');
        }

        const stringSession = new StringSession(existingSession);
        const baseLogger = this.newLogger();

        this.client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 10,
            useWSS: false,
            floodSleepThreshold: 60,
            baseLogger,
        });

        try {
            await Promise.race([
                this.client.connect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 15000))
            ]);
        } catch (err) {
            console.log('connect timeout/error, destroying client...');
            try { await this.client.disconnect(); } catch (e) {}
            this.client = null;
            throw new Error('Error de conexión con Telegram (Timeout). Intenta de nuevo.');
        }
    }

    // --- Last Downloads Tracking ---
    async getLastDownloads() {
        const channels = await prisma.telegramChannel.findMany({
            where: { lastMsgId: { not: null } },
            select: { name: true, lastMsgId: true, lastFileName: true, lastDownloadedAt: true, lastDownloadUrl: true }
        });
        
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const formatD = (d) => {
            if (!d) return null;
            const now = new Date(d);
            return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        };

        const res = {};
        for (const c of channels) {
            res[c.name] = {
                lastMsgId: c.lastMsgId,
                lastFileName: c.lastFileName || '',
                lastDownloadedAt: formatD(c.lastDownloadedAt),
                url: c.lastDownloadUrl || ''
            };
        }
        return res;
    }

    async saveLastDownload(channelName, msgId, fileName) {
        let urlPath = channelName;
        if (String(channelName).startsWith('-100')) {
            urlPath = `c/${String(channelName).substring(4)}`;
        }
        const url = `https://t.me/${urlPath}/${msgId}`;

        await prisma.telegramChannel.upsert({
            where: { name: channelName },
            create: {
                name: channelName,
                lastMsgId: msgId,
                lastFileName: fileName,
                lastDownloadedAt: new Date(),
                lastDownloadUrl: url
            },
            update: {
                lastMsgId: msgId,
                lastFileName: fileName,
                lastDownloadedAt: new Date(),
                lastDownloadUrl: url
            }
        });
    }

    async getLastDownloadForChannel(channelName) {
        const channel = await prisma.telegramChannel.findUnique({
            where: { name: channelName },
            select: { lastMsgId: true, lastFileName: true, lastDownloadedAt: true, lastDownloadUrl: true }
        });
        if (!channel || !channel.lastMsgId) return null;
        
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const formatD = (d) => {
            if (!d) return null;
            const now = new Date(d);
            return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        };

        return {
            lastMsgId: channel.lastMsgId,
            lastFileName: channel.lastFileName || '',
            lastDownloadedAt: formatD(channel.lastDownloadedAt),
            url: channel.lastDownloadUrl || ''
        };
    }

    // --- Channel Info with smart suggestions ---
    async getChannelInfo(channelName, maxGB = 150) {
        await this.initClient();
        
        const messages = await this.client.getMessages(channelName, { limit: 1 });
        if (!messages || messages.length === 0) {
            throw new Error('No se encontraron mensajes en el canal o no tienes acceso.');
        }

        const maxId = messages[0].id;
        const lastDownload = await this.getLastDownloadForChannel(channelName);
        const suggestedStart = lastDownload ? lastDownload.lastMsgId + 1 : Math.max(1, maxId - 100);
        const newMessages = maxId - suggestedStart + 1;

        return {
            channelName,
            maxId,
            suggestedStart,
            suggestedEnd: maxId,
            newMessages: Math.max(0, newMessages),
            lastDownload
        };
    }

    // Quick scan that counts actual FILES (not text messages)
    async quickScanFiles(channelName, onProgress = null) {
        this.shouldCancel = false;
        await this.initClient();

        const lastDownload = await this.getLastDownloadForChannel(channelName);
        const messages = await this.client.getMessages(channelName, { limit: 1 });
        if (!messages || messages.length === 0) {
            throw new Error('No se encontraron mensajes en el canal o no tienes acceso.');
        }

        const maxId = messages[0].id;
        const startFrom = lastDownload ? lastDownload.lastMsgId + 1 : Math.max(1, maxId - 100);

        if (startFrom > maxId) {
            return { newFiles: 0, totalMessages: 0, totalSize: '0 B', totalSizeBytes: 0, maxId };
        }

        let currentOffsetId = startFrom - 1;
        let fileCount = 0;
        let totalBytes = 0;
        let messagesScanned = 0;
        const maxLimit = 200000;

        if (onProgress) {
            onProgress({
                type: 'scan_progress',
                channelName,
                scanned: 0,
                maxLimit
            });
        }

        while (messagesScanned < maxLimit) {
            if (this.shouldCancel) break;
            const chunk = await this.client.getMessages(channelName, {
                limit: Math.min(100, maxLimit - messagesScanned),
                offsetId: currentOffsetId,
                reverse: true,
            });

            if (!chunk || chunk.length === 0) break;

            for (const msg of chunk) {
                messagesScanned++;
                currentOffsetId = msg.id;

                if (!msg.media) continue;
                fileCount++;
                if (msg.media.document) {
                    totalBytes += Number(msg.media.document.size || 0);
                } else {
                    totalBytes += this.estimateMediaSizeBytes(msg);
                }
            }

            if (onProgress) {
                onProgress({
                    type: 'scan_progress',
                    channelName,
                    scanned: messagesScanned,
                    maxLimit
                });
            }
        }
        const totalMessages = messagesScanned;

        return {
            newFiles: fileCount,
            totalMessages,
            totalSize: this.formatBytes(totalBytes),
            totalSizeBytes: totalBytes,
            maxId,
        };
    }

    // Scan messages to calculate how many fit within maxGB
    async scanWithLimit(channelName, startId, maxGB, onProgress = null) {
        this.shouldCancel = false;
        await this.initClient();

        const maxBytes = maxGB * 1024 * 1024 * 1024;
        let currentOffsetId = startId - 1; 
        let cumSize = 0;
        let lastFitId = startId;
        let fileCount = 0;
        let shouldStop = false;
        let messagesScanned = 0;
        const maxLimit = 200000;

        if (onProgress) {
            onProgress({
                type: 'scan_progress',
                channelName,
                scanned: 0,
                maxLimit
            });
        }

        while (messagesScanned < maxLimit) {
            if (this.shouldCancel) break;
            const chunk = await this.client.getMessages(channelName, {
                limit: Math.min(100, maxLimit - messagesScanned),
                offsetId: currentOffsetId,
                reverse: true
            });

            if (!chunk || chunk.length === 0) break;

            for (const msg of chunk) {
                messagesScanned++;
                currentOffsetId = msg.id;

                if (!msg.media) continue;
                
                let size = 0;
                if (msg.media.document) size = Number(msg.media.document.size || 0);
                else size = this.estimateMediaSizeBytes(msg);

                if (cumSize + size > maxBytes) {
                    shouldStop = true;
                    break;
                }
                
                cumSize += size;
                lastFitId = msg.id;
                fileCount++;
            }

            if (onProgress) {
                onProgress({
                    type: 'scan_progress',
                    channelName,
                    scanned: messagesScanned,
                    maxLimit
                });
            }

            if (shouldStop) break;
        }
        
        if (fileCount === 0 && cumSize === 0) {
            return { suggestedEndId: startId, totalFiles: 0, totalSizeStr: '0 B', totalSizeBytes: 0 };
        }

        return {
            suggestedEndId: lastFitId,
            totalFiles: fileCount,
            totalSizeStr: this.formatBytes(cumSize),
            totalSizeBytes: cumSize
        };
    }

    formatBytes(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let value = bytes;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
    }

    estimateMediaSizeBytes(msg) {
        try {
            if (msg?.media?.document?.size) return Number(msg.media.document.size);
            const sizes = msg?.media?.photo?.sizes;
            if (!Array.isArray(sizes) || sizes.length === 0) return 0;
            let best = 0;
            for (const s of sizes) {
                if (!s) continue;
                if (typeof s.size === 'number') best = Math.max(best, s.size);
                if (Array.isArray(s.sizes) && s.sizes.length) {
                    const m = Math.max(...s.sizes.filter((n) => typeof n === 'number'));
                    if (Number.isFinite(m)) best = Math.max(best, m);
                }
                if (s.bytes && typeof s.bytes.length === 'number') best = Math.max(best, s.bytes.length);
            }
            return best;
        } catch {
            return 0;
        }
    }

    sanitizeFileName(fileName, fallbackName = 'archivo', maxLength = 180) {
        let name = String(fileName ?? '').trim();
        if (!name) name = fallbackName;
        name = name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
        name = name.replace(/\s+/g, ' ').trim();
        name = name.replace(/[. ]+$/g, '');
        if (!name) name = fallbackName;
        return name;
    }

    isFileReferenceExpiredError(err) {
        const msg = String(err?.message || '');
        const errorMessage = String(err?.errorMessage || '');
        return (
            errorMessage === 'FILE_REFERENCE_EXPIRED' ||
            msg.includes('FILE_REFERENCE_EXPIRED')
        );
    }

    async refetchMessageById(channelName, msgId) {
        const id = Number(msgId);
        if (!Number.isFinite(id) || id <= 0) return null;
        const res = await this.client.getMessages(channelName, { ids: id });
        return Array.isArray(res) && res.length ? res[0] : null;
    }

    async parallelDownloadToFile(client, fileLocation, { dcId, fileSizeBytes, outputFile, workers, partSizeKb, progressCallback, msgId, resumeDone }) {
        const partSize = Math.floor(partSizeKb * 1024);
        if (partSize % 4096 !== 0) throw new Error('partSizeKb debe ser divisible por 4KB');
        
        const stride = partSize * workers;
        const totalChunks = Math.ceil(fileSizeBytes / partSize);
        const strideBig = bigInt(stride);

        // Si hay avance válido guardado se abre sin truncar y cada worker sigue donde se quedó.
        const done = resumeDone ? [...resumeDone] : Array(workers).fill(0);
        const fd = fs.openSync(outputFile, resumeDone ? 'r+' : 'w');
        const saveState = () => {
            try {
                fs.fsyncSync(fd); // los datos van a disco antes de anotar que están hechos
                savePartState(outputFile, { msgId, fileSizeBytes, partSize, workers, done });
            } catch (e) {
                console.error('[Telegram Downloader] No se pudo guardar el avance del archivo:', e.message);
            }
        };
        this.flushPartState = saveState;
        try {
            if (!resumeDone) fs.ftruncateSync(fd, fileSizeBytes);
            let downloaded = resumeDone ? bytesFromDone(done, partSize, fileSizeBytes) : 0;
            let lastPrint = 0;
            let lastBytes = downloaded;
            let lastTime = Date.now();
            let lastSave = 0;
            saveState();

            const report = async () => {
                if (!progressCallback) return;
                const now = Date.now();
                if (now - lastPrint < 1000) return;
                lastPrint = now;

                const deltaBytes = Math.max(0, downloaded - lastBytes);
                const deltaTime = Math.max(1, now - lastTime);
                lastBytes = downloaded;
                lastTime = now;
                await progressCallback(bigInt(downloaded), bigInt(fileSizeBytes), {
                    speedBytesPerSec: (deltaBytes * 1000) / deltaTime,
                });
            };

            const workerTasks = Array.from({ length: workers }, (_, workerIndex) =>
                (async () => {
                    const chunksForWorker = workerIndex >= totalChunks ? 0 : Math.ceil((totalChunks - workerIndex) / workers);
                    const remaining = chunksForWorker - done[workerIndex];
                    if (remaining <= 0) return;

                    let offset = bigInt(workerIndex * partSize).add(strideBig.multiply(done[workerIndex]));
                    const iter = client.iterDownload({
                        file: fileLocation,
                        dcId,
                        fileSize: bigInt(fileSizeBytes),
                        offset,
                        stride,
                        chunkSize: partSize,
                        requestSize: partSize,
                        limit: remaining,
                    });

                    for await (const chunk of iter) {
                        if (this.shouldCancel) return;
                        const position = offset.toJSNumber();
                        fs.writeSync(fd, chunk, 0, chunk.length, position);
                        offset = offset.add(strideBig);
                        downloaded += chunk.length;
                        done[workerIndex]++;
                        if (Date.now() - lastSave >= PART_STATE_SAVE_EVERY_MS) {
                            lastSave = Date.now();
                            saveState();
                        }
                        await report();
                    }
                })(),
            );

            await Promise.all(workerTasks);
            await report();
        } finally {
            // Si se interrumpe (apagado, cancelación o error) queda el avance guardado; si terminó, ya no hace falta.
            if (done.every((n, w) => n >= (w >= totalChunks ? 0 : Math.ceil((totalChunks - w) / workers)))) {
                clearPartState(outputFile);
            } else {
                saveState();
            }
            this.flushPartState = null;
            fs.closeSync(fd);
        }
    }

    emitProgress(data) {
        if (this.downloadInfo) {
            data.channelName = this.downloadInfo.channelName;
        }
        // Save state for reconnecting clients
        if (data.type === 'progress') {
            this.lastProgress = data;
        } else {
            // Store non-progress events in log buffer (keep last 100)
            this.logBuffer.push(data);
            if (this.logBuffer.length > 100) this.logBuffer.shift();
        }
        
        // Clear state on finish
        if (data.type === 'finish') {
            this.lastProgress = null;
            this.downloadInfo = null;
        }
        
        if (this.progressEmitter) {
            this.progressEmitter(data);
        }
    }

    getReconnectState() {
        return {
            isDownloading: this.isDownloading,
            lastProgress: this.lastProgress,
            logBuffer: [...this.logBuffer],
            downloadInfo: this.downloadInfo
        };
    }

    cancelDownload() {
        this.shouldCancel = true;
    }

    // --- Trabajos de descarga persistidos (para retomarlos tras un reinicio) ---
    async finishJob(jobId, status, lastError = null) {
        if (!jobId) return;
        try {
            if (status === 'COMPLETED') {
                // Terminada bien: no hace falta conservar nada (lo descargado ya queda en TelegramChannel.lastMsgId).
                await prisma.telegramDownloadJob.delete({ where: { id: jobId } });
                return;
            }
            await prisma.telegramDownloadJob.update({
                where: { id: jobId },
                data: { status, lastError, finishedAt: new Date() }
            });
        } catch (e) {
            console.error('[Telegram Downloader] No se pudo actualizar el trabajo de descarga:', e.message);
        }
    }

    // Avisa al servicio de que el proceso va a cerrarse: corta la descarga SIN darla por cancelada
    // y deja guardado el avance del archivo en curso para que el próximo arranque lo retome.
    async prepareShutdown(maxWaitMs = 1200) {
        if (!this.isDownloading) return;
        this.shuttingDown = true;
        this.shouldCancel = true;
        try { this.flushPartState?.(); } catch {}
        const deadline = Date.now() + maxWaitMs;
        while (this.isDownloading && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }
        try { this.flushPartState?.(); } catch {}
    }

    // Al arrancar el backend: retoma la descarga que quedó a medias (si la hay). Devuelve la promesa de la descarga.
    async resumeInterruptedDownload(onProgress) {
        if (this.isDownloading) return null;
        // Limpieza: los trabajos fallidos o cancelados se conservan 7 días para diagnosticar y luego se borran.
        await prisma.telegramDownloadJob.deleteMany({
            where: { status: { not: 'RUNNING' }, updatedAt: { lt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }
        }).catch(() => {});
        const jobs = await prisma.telegramDownloadJob.findMany({ where: { status: 'RUNNING' }, orderBy: { id: 'desc' } });
        if (jobs.length === 0) return null;

        const [job, ...older] = jobs;
        // Nunca dos descargas a la vez: los trabajos más antiguos "en curso" quedaron huérfanos.
        for (const o of older) await this.finishJob(o.id, 'CANCELLED', 'Reemplazada por un trabajo más reciente');

        if (job.resumeCount >= MAX_AUTO_RESUMES) {
            await this.finishJob(job.id, 'FAILED', `Se interrumpió más de ${MAX_AUTO_RESUMES} veces seguidas; no se reintenta sola.`);
            return null;
        }
        if (!(await this.checkAuth())) {
            await this.finishJob(job.id, 'FAILED', 'No hay sesión de Telegram para retomar la descarga.');
            return null;
        }

        await prisma.telegramDownloadJob.update({ where: { id: job.id }, data: { resumeCount: { increment: 1 } } });
        console.log(`[Telegram Downloader] Retomando descarga de ${job.channelName} (${job.startId}-${job.endId}), intento ${job.resumeCount + 1}`);

        const params = { channelName: job.channelName, startId: job.startId, endId: job.endId, jobId: job.id };
        return (async () => {
            let outcome = await this.startDownload(params, onProgress);
            // Si Telegram no estaba alcanzable justo al arrancar, se reintenta unas veces antes de rendirse.
            for (let attempt = 1; outcome === 'failed' && attempt <= 3; attempt++) {
                await new Promise((r) => setTimeout(r, 30000));
                await prisma.telegramDownloadJob.update({ where: { id: job.id }, data: { status: 'RUNNING', finishedAt: null } });
                outcome = await this.startDownload(params, onProgress);
            }
            return outcome;
        })();
    }

    // Devuelve: 'completed' | 'empty' | 'cancelled' | 'interrupted' | 'failed'
    async startDownload({ channelName, startId, endId, jobId = null }, onProgress) {
        if (this.isDownloading) throw new Error('Ya hay una descarga en progreso.');

        this.isDownloading = true;
        this.shouldCancel = false;
        this.shuttingDown = false;
        this.reconnectStorm = false;
        this.reconnectTimes = [];
        this.currentJobId = jobId;
        let outcome = 'completed';
        let failMessage = null;
        this.progressEmitter = onProgress;
        this.lastProgress = null;
        this.logBuffer = [];
        this.downloadInfo = { channelName, startId, endId, startedAt: new Date().toISOString() };

        try {
            if (!jobId) {
                // Registro durable de la descarga: si el backend se reinicia, al arrancar se retoma sola.
                await prisma.telegramDownloadJob.updateMany({
                    where: { status: 'RUNNING' },
                    data: { status: 'CANCELLED', finishedAt: new Date(), lastError: 'Reemplazada por una descarga nueva' }
                });
                const job = await prisma.telegramDownloadJob.create({ data: { channelName, startId, endId } });
                this.currentJobId = job.id;
            }

            await this.initClient();
            this.emitProgress({ type: 'info', message: `Calculando archivos para ${channelName}...` });

            const messages = [];
            let currentOffsetId = endId + 1;
            let chunksFetched = 0;
            
            while (true) {
                if (this.shouldCancel) break;
                
                const chunk = await this.client.getMessages(channelName, {
                    limit: 100,
                    offsetId: currentOffsetId,
                    reverse: false // Fetches newest to oldest cleanly
                });
                
                chunksFetched++;
                if (chunksFetched % 5 === 0) {
                    this.emitProgress({ type: 'info', message: `Escaneando historial... (Lote ${chunksFetched})` });
                }
                
                if (!chunk || chunk.length === 0) break;
                
                let reachedStart = false;
                for (const msg of chunk) {
                    if (msg.id < startId) {
                        reachedStart = true;
                        break;
                    }
                    if (msg.id <= endId) {
                        messages.push(msg);
                    }
                    currentOffsetId = msg.id;
                }
                
                if (reachedStart) break;
            }
            
            // Revertir para procesar en orden cronológico (de startId a endId)
            messages.reverse();

            if (this.shouldCancel) {
                outcome = this.shuttingDown ? 'interrupted' : this.reconnectStorm ? 'failed' : 'cancelled';
                if (this.reconnectStorm) failMessage = 'Bucle de reconexión con Telegram';
                return outcome;
            }

            if (messages.length === 0) {
                this.emitProgress({ type: 'error', message: 'No se encontraron mensajes en ese rango.' });
                outcome = 'empty';
                return outcome;
            }

            let totalSizeBytes = 0;
            const downloadList = [];

            for (const msg of messages) {
                if (msg.media) {
                    let size = 0;
                    let originalName = '';
                    if (msg.media.document) {
                        size = msg.media.document.size;
                        const attr = msg.media.document.attributes.find((a) => a.fileName);
                        originalName = attr ? attr.fileName : `archivo_${msg.id}.dat`;
                    } else if (msg.media.photo) {
                        originalName = `foto_${msg.id}.jpg`;
                    }

                    const estimatedSizeBytes = size ? Number(size) : this.estimateMediaSizeBytes(msg);
                    totalSizeBytes += estimatedSizeBytes;
                    downloadList.push({ msg, originalName, estimatedSizeBytes });
                }
            }

            downloadList.sort((a, b) => (Number(a?.msg?.id) || 0) - (Number(b?.msg?.id) || 0));

            const totalItems = downloadList.length;
            let completedBytes = 0;

            this.emitProgress({ 
                type: 'start', 
                totalFiles: totalItems, 
                totalBytesStr: this.formatBytes(totalSizeBytes),
                totalBytes: totalSizeBytes
            });

            for (let idx = 0; idx < totalItems; idx++) {
                if (this.shouldCancel) {
                    if (!this.shuttingDown && !this.reconnectStorm) this.emitProgress({ type: 'info', message: 'Descarga cancelada por el usuario.' });
                    break;
                }

                const item = downloadList[idx];
                const safeName = this.sanitizeFileName(item.originalName);
                const channelTag = String(channelName || 'unknown')
                    .replace(/^[@-]+/, '')
                    .replace(/[^a-zA-Z0-9]/g, '')
                    .substring(0, 30) || 'ch';
                const finalFileName = `${channelTag}_${item.msg.id}_${safeName}`;
                const fullPath = path.join(UPLOADS_DIR, finalFileName);
                const tempPath = `${fullPath}.part`;

                this.emitProgress({
                    type: 'file_start',
                    fileIndex: idx + 1,
                    totalFiles: totalItems,
                    fileName: item.originalName,
                    msgId: item.msg.id
                });

                if (fs.existsSync(fullPath)) {
                    const existingSize = fs.statSync(fullPath).size;
                    const expectedSize = item.msg?.media?.document?.size ? Number(item.msg.media.document.size) : 0;
                    if (existingSize > 0 && (!expectedSize || existingSize === expectedSize)) {
                        completedBytes += existingSize;
                        this.emitProgress({ type: 'file_skip', fileName: finalFileName });
                        continue;
                    }
                    try { fs.unlinkSync(fullPath); } catch {}
                }

                let lastBytes = 0;
                let lastTime = Date.now();

                const progressCallback = async (downloadedBigInt, totalBigInt, extras) => {
                    if (this.shouldCancel) return;
                    
                    const downloaded = Number(downloadedBigInt?.toString?.() ?? downloadedBigInt ?? 0);
                    const total = Number(totalBigInt?.toString?.() ?? totalBigInt ?? 0);
                    
                    const now = Date.now();
                    const deltaBytes = Math.max(0, downloaded - lastBytes);
                    const deltaTime = Math.max(1, now - lastTime);
                    const speedBytesPerSec = extras?.speedBytesPerSec || ((deltaBytes * 1000) / deltaTime);
                    
                    lastBytes = downloaded;
                    lastTime = now;

                    const overallDone = completedBytes + downloaded;
                    
                    this.emitProgress({
                        type: 'progress',
                        fileName: item.originalName,
                        filePct: total > 0 ? (downloaded / total) * 100 : 0,
                        overallPct: totalSizeBytes > 0 ? (overallDone / totalSizeBytes) * 100 : 0,
                        speedStr: `${this.formatBytes(speedBytesPerSec)}/s`,
                        downloadedStr: this.formatBytes(downloaded),
                        totalStr: this.formatBytes(total)
                    });
                };

                const downloadOnce = async (msgToDownload) => {
                    const isBigDocument = Boolean(msgToDownload?.media?.document) && Number(msgToDownload.media.document.size || 0) >= FAST_DOWNLOAD_MIN_BYTES;

                    if (isBigDocument) {
                        let info;
                        try { info = getFileInfo(msgToDownload.media); } catch (e) { info = undefined; }

                        if (info?.location && info?.dcId) {
                            const sizeBig = info.size;
                            const size = sizeBig ? Number(sizeBig.toString()) : Number(msgToDownload.media.document.size || 0);
                            // Si quedó un .part con avance válido (reinicio, corte...) se retoma a mitad de archivo.
                            const resumeDone = loadPartState(tempPath, {
                                msgId: msgToDownload.id,
                                fileSizeBytes: size,
                                partSize: FAST_PART_SIZE_KB * 1024,
                                workers: FAST_WORKERS,
                            });
                            if (resumeDone) {
                                this.emitProgress({ type: 'info', message: `Retomando ${item.originalName} desde ${this.formatBytes(bytesFromDone(resumeDone, FAST_PART_SIZE_KB * 1024, size))}...` });
                            }
                            return this.parallelDownloadToFile(this.client, info.location, {
                                dcId: info.dcId,
                                fileSizeBytes: size,
                                outputFile: tempPath,
                                workers: FAST_WORKERS,
                                partSizeKb: FAST_PART_SIZE_KB,
                                progressCallback,
                                msgId: msgToDownload.id,
                                resumeDone,
                            });
                        }
                    }

                    // Archivos pequeños o sin ubicación directa: no se puede retomar, se descargan de cero.
                    try { fs.unlinkSync(tempPath); } catch {}
                    clearPartState(tempPath);
                    return this.client.downloadMedia(msgToDownload, { outputFile: tempPath, progressCallback });
                };

                const downloadWithStallDetector = async (msgToDownload) => {
                    lastTime = Date.now(); // reset timer
                    let interval;
                    const stallPromise = new Promise((_, reject) => {
                        interval = setInterval(() => {
                            if (this.shouldCancel) {
                                clearInterval(interval);
                                reject(new Error('Cancelada'));
                            } else if (Date.now() - lastTime > 120000) {
                                clearInterval(interval);
                                reject(new Error('Descarga estancada (timeout de 2 minutos sin progreso)'));
                            }
                        }, 5000);
                    });

                    try {
                        await Promise.race([
                            downloadOnce(msgToDownload),
                            stallPromise
                        ]);
                    } finally {
                        clearInterval(interval);
                    }

                    if (!this.shouldCancel) {
                        if (!fs.existsSync(tempPath)) {
                            this.emitProgress({ type: 'file_skip', fileName: finalFileName, reason: 'Media sin archivo descargable' });
                        } else {
                            fs.renameSync(tempPath, fullPath);
                            completedBytes += fs.statSync(fullPath).size;
                            this.saveLastDownload(channelName, item.msg.id, finalFileName);
                            this.emitProgress({ type: 'file_done', fileName: finalFileName });
                        }
                    }
                };

                try {
                    await downloadWithStallDetector(item.msg);
                } catch (err) {
                    if (this.isFileReferenceExpiredError(err)) {
                        this.emitProgress({ type: 'info', message: `Referencia expirada en ${item.msg.id}. Reintentando...` });
                        try {
                            const fresh = await this.refetchMessageById(channelName, item.msg.id);
                            if (fresh?.media) {
                                item.msg = fresh; // el avance guardado sigue siendo válido: es el mismo archivo
                                await downloadWithStallDetector(fresh);
                                continue;
                            }
                        } catch (retryErr) {
                            err = retryErr;
                        }
                    }
                    
                    if (this.shuttingDown || this.reconnectStorm) break; // apagado o cliente cortado: se conserva el .part para retomarlo
                    if (this.shouldCancel) {
                        // Cancelación del usuario: se descarta lo parcial.
                        try { fs.unlinkSync(tempPath); } catch {}
                        clearPartState(tempPath);
                        break;
                    }
                    // Error normal: el .part y su avance se conservan, el siguiente intento los retoma.
                    this.emitProgress({ type: 'error', message: `Error en ${item.msg.id}: ${err.message}` });
                }
            }

            if (this.shuttingDown) {
                outcome = 'interrupted';
            } else if (this.reconnectStorm) {
                outcome = 'failed';
                failMessage = 'Bucle de reconexión con Telegram';
                this.emitProgress({ type: 'error', message: 'Se cortó la conexión con Telegram por un bucle de reconexión; se reintentará.' });
            } else if (this.shouldCancel) {
                outcome = 'cancelled';
                this.emitProgress({ type: 'finish', message: 'Descarga cancelada.' });
            } else {
                this.emitProgress({ type: 'finish', message: 'Descarga completada.' });
            }
        } catch (error) {
            if (this.shuttingDown) {
                outcome = 'interrupted';
            } else {
                outcome = 'failed';
                failMessage = error.message;
                this.emitProgress({ type: 'error', message: error.message });
            }
        } finally {
            // 'interrupted' deja el trabajo en RUNNING: el próximo arranque del backend lo retoma.
            const jid = this.currentJobId;
            if (outcome === 'completed' || outcome === 'empty') await this.finishJob(jid, 'COMPLETED');
            else if (outcome === 'cancelled') await this.finishJob(jid, 'CANCELLED', 'Cancelada por el usuario');
            else if (outcome === 'failed') await this.finishJob(jid, 'FAILED', failMessage);
            this.currentJobId = null;
            this.isDownloading = false;
        }
        return outcome;
    }
}

export default new TelegramDownloaderService();

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger } from 'telegram/extensions/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { getFileInfo } from 'telegram/Utils.js';
import bigInt from 'big-integer';
import fs from 'fs';
import path from 'path';

// Api ID and Hash for the client
const apiId = 32505903;
const apiHash = 'c99427986581742a5cefcfe990e9884a';

const SESSION_PATH = path.join(process.cwd(), 'data', 'telegram.session');
const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'telegram_downloads');
const LAST_DOWNLOADS_PATH = path.join(process.cwd(), 'data', 'last_downloads.json');

const FAST_DOWNLOAD_MIN_BYTES = 20 * 1024 * 1024;
const FAST_WORKERS = 4;
const FAST_PART_SIZE_KB = 512;

class FilteredLogger extends Logger {
    log(level, message, color) {
        const msg = String(message ?? '');
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

class TelegramDownloaderService {
    constructor() {
        this.client = null;
        this.isDownloading = false;
        this.shouldCancel = false;
        this.progressEmitter = null; // Callback for SSE
        
        // Auth flow resolvers
        this.resolvePhoneCode = null;
        this.resolvePassword = null;
        this.authError = null;
        this.isAuthenticating = false;
        
        // Persistent state for reconnecting clients
        this.lastProgress = null;   // Last progress event
        this.logBuffer = [];        // Last N log events
        this.downloadInfo = null;   // { channelName, startId, endId, startedAt }
        
        if (!fs.existsSync(UPLOADS_DIR)) {
            fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        }
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
            fs.unlinkSync(path.join(UPLOADS_DIR, file));
            count++;
        }
        return count;
    }

    async startAuth(phoneNumber) {
        if (this.isAuthenticating) {
            throw new Error('Ya hay un proceso de autenticación en curso. Espera a que termine.');
        }

        this.isAuthenticating = true;
        this.authError = null;

        const stringSession = new StringSession("");
        const baseLogger = new FilteredLogger(LogLevel.INFO);
        this.client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 1,   // Solo 1 reintento para evitar FLOOD
            retryDelay: 5000,
            useWSS: false,
            baseLogger
        });

        // Este proceso corre en background y espera a que resuelvas las promesas
        this.client.start({
            phoneNumber: async () => phoneNumber,
            password: async () => new Promise(resolve => { this.resolvePassword = resolve; }),
            phoneCode: async () => new Promise(resolve => { this.resolvePhoneCode = resolve; }),
            onError: (err) => { 
                this.authError = err.message;
                console.error("Auth Error:", err);
                // Retornar true para indicar a GramJS que NO reintente
                return true;
            },
        }).then(() => {
            const sessionStr = this.client.session.save();
            if (!fs.existsSync(path.dirname(SESSION_PATH))) {
                fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
            }
            fs.writeFileSync(SESSION_PATH, sessionStr, 'utf8');
            console.log('Telegram session saved to data/telegram.session');
        }).catch(err => {
            this.authError = err.message;
            console.error("Auth final error:", err.message);
        }).finally(() => {
            this.isAuthenticating = false;
        });
    }

    provideCode(code) {
        if (this.resolvePhoneCode) {
            this.resolvePhoneCode(code);
            this.resolvePhoneCode = null;
        }
    }

    providePassword(password) {
        if (this.resolvePassword) {
            this.resolvePassword(password);
            this.resolvePassword = null;
        }
    }

    async initClient() {
        if (this.client && await this.client.checkAuthorization()) return;

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
        const baseLogger = new FilteredLogger(LogLevel.INFO);

        this.client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 10,
            useWSS: false,
            floodSleepThreshold: 60,
            baseLogger,
        });

        await this.client.connect(); // Since session is already authenticated
    }

    // --- Last Downloads Tracking ---
    getLastDownloads() {
        if (!fs.existsSync(LAST_DOWNLOADS_PATH)) return {};
        try { return JSON.parse(fs.readFileSync(LAST_DOWNLOADS_PATH, 'utf8')); } catch { return {}; }
    }

    saveLastDownload(channelName, msgId, fileName) {
        const data = this.getLastDownloads();
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        let urlPath = channelName;
        if (String(channelName).startsWith('-100')) {
            urlPath = `c/${String(channelName).substring(4)}`;
        }

        data[channelName] = {
            lastMsgId: msgId,
            lastFileName: fileName,
            lastDownloadedAt: dateStr,
            url: `https://t.me/${urlPath}/${msgId}`
        };

        const dir = path.dirname(LAST_DOWNLOADS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LAST_DOWNLOADS_PATH, JSON.stringify(data, null, 2), 'utf8');
    }

    getLastDownloadForChannel(channelName) {
        const data = this.getLastDownloads();
        return data[channelName] || null;
    }

    // --- Channel Info with smart suggestions ---
    async getChannelInfo(channelName, maxGB = 150) {
        await this.initClient();
        
        const messages = await this.client.getMessages(channelName, { limit: 1 });
        if (!messages || messages.length === 0) {
            throw new Error('No se encontraron mensajes en el canal o no tienes acceso.');
        }

        const maxId = messages[0].id;
        const lastDownload = this.getLastDownloadForChannel(channelName);
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

    // Scan messages to calculate how many fit within maxGB
    async scanWithLimit(channelName, startId, maxGB) {
        await this.initClient();

        const maxBytes = maxGB * 1024 * 1024 * 1024;
        // Fetch up to 5000 messages from startId forward
        const messages = await this.client.getMessages(channelName, {
            limit: 5000,
            offsetId: startId,
            reverse: true,
        });

        if (!messages || messages.length === 0) {
            return { suggestedEndId: startId, totalFiles: 0, totalSizeStr: '0 B', totalSizeBytes: 0 };
        }

        let cumSize = 0;
        let lastFitId = startId;
        let fileCount = 0;

        for (const msg of messages) {
            if (!msg.media) continue;
            let size = 0;
            if (msg.media.document) size = Number(msg.media.document.size || 0);
            else size = this.estimateMediaSizeBytes(msg);

            if (cumSize + size > maxBytes) break;
            cumSize += size;
            lastFitId = msg.id;
            fileCount++;
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

    async parallelDownloadToFile(client, fileLocation, { dcId, fileSizeBytes, outputFile, workers, partSizeKb, progressCallback }) {
        const partSize = Math.floor(partSizeKb * 1024);
        if (partSize % 4096 !== 0) throw new Error('partSizeKb debe ser divisible por 4KB');
        
        const stride = partSize * workers;
        const totalChunks = Math.ceil(fileSizeBytes / partSize);
        const strideBig = bigInt(stride);

        const fd = fs.openSync(outputFile, 'w');
        try {
            fs.ftruncateSync(fd, fileSizeBytes);
            let downloaded = 0;
            let lastPrint = 0;
            let lastBytes = 0;
            let lastTime = Date.now();

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
                    if (chunksForWorker <= 0) return;

                    let offset = bigInt(workerIndex * partSize);
                    const iter = client.iterDownload({
                        file: fileLocation,
                        dcId,
                        fileSize: bigInt(fileSizeBytes),
                        offset,
                        stride,
                        chunkSize: partSize,
                        requestSize: partSize,
                        limit: chunksForWorker,
                    });

                    for await (const chunk of iter) {
                        if (this.shouldCancel) return;
                        const position = offset.toJSNumber();
                        fs.writeSync(fd, chunk, 0, chunk.length, position);
                        offset = offset.add(strideBig);
                        downloaded += chunk.length;
                        await report();
                    }
                })(),
            );

            await Promise.all(workerTasks);
            await report();
        } finally {
            fs.closeSync(fd);
        }
    }

    emitProgress(data) {
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

    async startDownload({ channelName, startId, endId }, onProgress) {
        if (this.isDownloading) throw new Error('Ya hay una descarga en progreso.');
        
        this.isDownloading = true;
        this.shouldCancel = false;
        this.progressEmitter = onProgress;
        this.lastProgress = null;
        this.logBuffer = [];
        this.downloadInfo = { channelName, startId, endId, startedAt: new Date().toISOString() };

        try {
            await this.initClient();
            this.emitProgress({ type: 'info', message: `Calculando archivos para ${channelName}...` });

            const limit = endId - startId + 1;
            const messages = await this.client.getMessages(channelName, {
                limit: limit,
                offsetId: startId, // offsetId is actually where it starts getting older messages, so we might need reverse: true
                reverse: true,
            });

            if (!messages || messages.length === 0) {
                this.emitProgress({ type: 'error', message: 'No se encontraron mensajes en ese rango.' });
                return;
            }

            let totalSizeBytes = 0;
            const downloadList = [];

            for (const msg of messages) {
                if (msg.id > endId) break;
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
                    this.emitProgress({ type: 'info', message: 'Descarga cancelada por el usuario.' });
                    break;
                }

                const item = downloadList[idx];
                const safeName = this.sanitizeFileName(item.originalName);
                const finalFileName = `${item.msg.id}_${safeName}`;
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

                if (fs.existsSync(tempPath)) {
                    try { fs.unlinkSync(tempPath); } catch {}
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
                            await this.parallelDownloadToFile(this.client, info.location, {
                                dcId: info.dcId,
                                fileSizeBytes: size,
                                outputFile: tempPath,
                                workers: FAST_WORKERS,
                                partSizeKb: FAST_PART_SIZE_KB,
                                progressCallback,
                            });
                        } else {
                            await this.client.downloadMedia(msgToDownload, { outputFile: tempPath, progressCallback });
                        }
                    } else {
                        await this.client.downloadMedia(msgToDownload, { outputFile: tempPath, progressCallback });
                    }

                    if (!this.shouldCancel) {
                        fs.renameSync(tempPath, fullPath);
                        completedBytes += fs.statSync(fullPath).size;
                        this.saveLastDownload(channelName, item.msg.id, finalFileName);
                        this.emitProgress({ type: 'file_done', fileName: finalFileName });
                    }
                };

                try {
                    await downloadOnce(item.msg);
                } catch (err) {
                    if (this.isFileReferenceExpiredError(err)) {
                        this.emitProgress({ type: 'info', message: `Referencia expirada en ${item.msg.id}. Reintentando...` });
                        try {
                            const fresh = await this.refetchMessageById(channelName, item.msg.id);
                            if (fresh?.media) {
                                item.msg = fresh;
                                if (fs.existsSync(tempPath)) {
                                    try { fs.unlinkSync(tempPath); } catch {}
                                }
                                await downloadOnce(fresh);
                                continue;
                            }
                        } catch (retryErr) {
                            err = retryErr;
                        }
                    }
                    
                    this.emitProgress({ type: 'error', message: `Error en ${item.msg.id}: ${err.message}` });
                    if (fs.existsSync(tempPath)) {
                        try { fs.unlinkSync(tempPath); } catch {}
                    }
                }
            }

            this.emitProgress({ type: 'finish', message: 'Descarga completada.' });
        } catch (error) {
            this.emitProgress({ type: 'error', message: error.message });
        } finally {
            this.isDownloading = false;
        }
    }
}

export default new TelegramDownloaderService();

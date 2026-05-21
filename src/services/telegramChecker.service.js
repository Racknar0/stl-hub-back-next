import fs from 'fs';
import path from 'path';
import telegramDownloaderService from './telegramDownloader.service.js';

const CHANNELS_FILE = path.join(process.cwd(), 'data', 'telegram_channels.json');
const AVATARS_DIR = path.join(process.cwd(), 'uploads', 'telegram_avatars');

function getChannels() {
    if (!fs.existsSync(CHANNELS_FILE)) {
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveChannels(channels) {
    const dir = path.dirname(CHANNELS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf8');
}

class TelegramCheckerService {
    constructor() {
        this.timeoutId = null;
        this.isProcessing = false;
    }

    start() {
        if (this.timeoutId) return;
        console.log('[Telegram Checker] Iniciando worker de chequeo automático...');
        this.scheduleNextCheck(10000); // Empezar primer chequeo en 10 segundos
    }

    stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        console.log('[Telegram Checker] Worker detenido.');
    }

    calculateInterval(channelCount) {
        const count = Math.max(1, channelCount);
        // Distribuye 24 horas (1440 minutos) entre la cantidad de canales
        const intervalMins = 1440 / count;
        // Intervalo mínimo de 1 minuto
        const intervalMs = Math.max(1, intervalMins) * 60 * 1000;
        return intervalMs;
    }

    scheduleNextCheck(delayMs) {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        
        const channels = getChannels();
        const interval = delayMs !== undefined ? delayMs : this.calculateInterval(channels.length);
        
        const nextTimeStr = new Date(Date.now() + interval).toLocaleTimeString();
        console.log(`[Telegram Checker] Siguiente comprobación programada para las ${nextTimeStr} (espera: ${Math.round(interval / 1000 / 60 * 10) / 10} min)`);
        
        this.timeoutId = setTimeout(() => this.checkNextChannel(), interval);
    }

    async checkNextChannel() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            const channels = getChannels();
            if (channels.length === 0) {
                console.log('[Telegram Checker] No hay canales configurados para chequear.');
                this.scheduleNextCheck();
                return;
            }

            // 1. Evitar interrumpir descargas activas en curso
            if (telegramDownloaderService.isDownloading) {
                console.log('[Telegram Checker] Descarga activa en curso. Pospone chequeo 2 minutos.');
                this.scheduleNextCheck(2 * 60 * 1000);
                return;
            }

            // 2. Verificar autenticación
            const isAuth = await telegramDownloaderService.checkAuth();
            if (!isAuth) {
                console.log('[Telegram Checker] Telegram no autenticado. Pospone chequeo 10 minutos.');
                this.scheduleNextCheck(10 * 60 * 1000);
                return;
            }

            // 3. Buscar el canal más antiguo o nunca verificado
            // Clonamos para ordenar de forma segura
            const sorted = [...channels].sort((a, b) => {
                const dateA = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
                const dateB = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
                return dateA - dateB;
            });

            const targetChannel = sorted[0];
            console.log(`[Telegram Checker] Iniciando chequeo de: ${targetChannel.name} (${targetChannel.label || 'Sin alias'})`);

            await this.syncChannelData(targetChannel.name);

            // Programar el siguiente chequeo normal
            this.scheduleNextCheck();
        } catch (error) {
            console.error('[Telegram Checker] Error en ciclo de chequeo:', error);
            // Si hay un error general (como desconexión), reintentar en 5 minutos
            this.scheduleNextCheck(5 * 60 * 1000);
        } finally {
            this.isProcessing = false;
        }
    }

    async syncChannelData(channelName) {
        const channels = getChannels();
        const idx = channels.findIndex(c => c.name === channelName);
        if (idx === -1) return;

        try {
            await telegramDownloaderService.initClient();
            const client = telegramDownloaderService.client;

            // 1. Obtener datos de la entidad en Telegram
            const entity = await client.getEntity(channelName);
            
            // Actualizar label si existe un título real y no hay conflicto
            if (entity.title) {
                channels[idx].label = entity.title;
            }

            // 2. Descargar Avatar
            if (entity.photo) {
                try {
                    if (!fs.existsSync(AVATARS_DIR)) {
                        fs.mkdirSync(AVATARS_DIR, { recursive: true });
                    }
                    const avatarBuffer = await client.downloadProfilePhoto(entity);
                    if (avatarBuffer) {
                        const avatarPath = path.join(AVATARS_DIR, `${channelName}.jpg`);
                        fs.writeFileSync(avatarPath, avatarBuffer);
                        channels[idx].avatarUrl = `/uploads/telegram_avatars/${channelName}.jpg`;
                    }
                } catch (photoErr) {
                    console.error(`[Telegram Checker] Error descargando avatar de ${channelName}:`, photoErr.message);
                }
            } else {
                channels[idx].avatarUrl = null;
            }

            // 3. Ejecutar escaneo rápido de archivos pendientes
            const scan = await telegramDownloaderService.quickScanFiles(channelName);
            
            channels[idx].lastScanResult = {
                newFiles: scan.newFiles,
                totalSize: scan.totalSize,
                totalSizeBytes: scan.totalSizeBytes,
                maxId: scan.maxId,
                error: false
            };
            channels[idx].lastCheckedAt = new Date().toISOString();

            console.log(`[Telegram Checker] Sincronización exitosa: ${channelName} | ${scan.newFiles} archivos nuevos (${scan.totalSize})`);

        } catch (error) {
            console.error(`[Telegram Checker] Error sincronizando canal ${channelName}:`, error.message);
            
            // Para evitar loops infinitos, marcamos el canal como comprobado con error
            channels[idx].lastCheckedAt = new Date().toISOString();
            channels[idx].lastScanResult = {
                newFiles: 0,
                totalSize: '—',
                totalSizeBytes: 0,
                maxId: channels[idx].lastScanResult?.maxId || 0,
                error: true,
                errorMessage: error.message
            };

            // Si es un error de FloodWait de Telegram, capturamos los segundos para pausar el worker
            if (error.message && error.message.includes('FLOOD_WAIT_')) {
                const match = error.message.match(/FLOOD_WAIT_(\d+)/);
                if (match) {
                    const waitSeconds = parseInt(match[1]) || 60;
                    console.warn(`[Telegram Checker] Detectado FLOOD_WAIT. Pausando el checker por ${waitSeconds + 10} segundos.`);
                    // Reprogramamos con la espera solicitada + 10 segundos de colchón
                    this.scheduleNextCheck((waitSeconds + 10) * 1000);
                }
            }
        }

        // Guardamos los cambios en el archivo JSON
        saveChannels(channels);
    }
}

export default new TelegramCheckerService();

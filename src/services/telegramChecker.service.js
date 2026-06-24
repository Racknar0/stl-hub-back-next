import fs from 'fs';
import path from 'path';
import telegramDownloaderService from './telegramDownloader.service.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const AVATARS_DIR = path.join(process.cwd(), 'uploads', 'telegram_avatars');

async function getChannels() {
    return await prisma.telegramChannel.findMany({
        orderBy: { name: 'asc' }
    });
}

class TelegramCheckerService {
    constructor() {
        this.timeoutId = null;
        this.isProcessing = false;
    }

    start() {
        if (this.timeoutId) return;
        this.scheduleNextCheck(10000); // Empezar primer chequeo en 10 segundos
    }

    stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    calculateInterval(channelCount) {
        const count = Math.max(1, channelCount);
        // Distribuye 24 horas (1440 minutos) entre la cantidad de canales
        const intervalMins = 1440 / count;
        // Intervalo mínimo de 1 minuto
        const intervalMs = Math.max(1, intervalMins) * 60 * 1000;
        return intervalMs;
    }

    async scheduleNextCheck(delayMs) {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        
        try {
            const channels = await getChannels();
            const interval = delayMs !== undefined ? delayMs : this.calculateInterval(channels.length);
            this.timeoutId = setTimeout(() => this.checkNextChannel(), interval);
        } catch (err) {
            console.error('[Telegram Checker] Error programando siguiente chequeo:', err);
            // Reintentar en 1 minuto en caso de error de BD
            this.timeoutId = setTimeout(() => this.checkNextChannel(), 60000);
        }
    }

    async checkNextChannel() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            const channels = await getChannels();
            if (channels.length === 0) {
                await this.scheduleNextCheck();
                return;
            }

            // 1. Evitar interrumpir descargas activas en curso
            if (telegramDownloaderService.isDownloading) {
                await this.scheduleNextCheck(2 * 60 * 1000);
                return;
            }

            // 2. Verificar autenticación
            const isAuth = await telegramDownloaderService.checkAuth();
            if (!isAuth) {
                await this.scheduleNextCheck(10 * 60 * 1000);
                return;
            }

            // 3. Buscar el canal más antiguo o nunca verificado
            const sorted = [...channels].sort((a, b) => {
                const dateA = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
                const dateB = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
                return dateA - dateB;
            });

            const targetChannel = sorted[0];
            await this.syncChannelData(targetChannel.name);

            // Programar el siguiente chequeo normal
            await this.scheduleNextCheck();
        } catch (error) {
            console.error('[Telegram Checker] Error en ciclo de chequeo:', error);
            // Si hay un error general (como desconexión), reintentar en 5 minutos
            await this.scheduleNextCheck(5 * 60 * 1000);
        } finally {
            this.isProcessing = false;
        }
    }

    async syncChannelData(channelName, onProgress = null) {
        const channel = await prisma.telegramChannel.findUnique({ where: { name: channelName } });
        if (!channel) return;

        try {
            console.info(`[Telegram Checker] Iniciando chequeo de: ${channelName}${channel.label ? ` (${channel.label})` : ''}`);
            await telegramDownloaderService.initClient();
            const client = telegramDownloaderService.client;

            // 1. Obtener datos de la entidad en Telegram
            const entity = await client.getEntity(channelName);
            
            let label = channel.label || '';
            if (entity.title) {
                label = entity.title;
            }

            // 2. Descargar Avatar
            let avatarUrl = channel.avatarUrl;
            if (entity.photo) {
                try {
                    if (!fs.existsSync(AVATARS_DIR)) {
                        fs.mkdirSync(AVATARS_DIR, { recursive: true });
                    }
                    const avatarBuffer = await client.downloadProfilePhoto(entity);
                    if (avatarBuffer) {
                        const avatarPath = path.join(AVATARS_DIR, `${channelName}.jpg`);
                        fs.writeFileSync(avatarPath, avatarBuffer);
                        avatarUrl = `/uploads/telegram_avatars/${channelName}.jpg`;
                    }
                } catch (photoErr) {
                    console.error(`[Telegram Checker] Error descargando avatar de ${channelName}:`, photoErr.message);
                }
            } else {
                avatarUrl = null;
            }

            // 3. Ejecutar escaneo rápido de archivos pendientes
            const scan = await telegramDownloaderService.quickScanFiles(channelName, onProgress);
            
            await prisma.telegramChannel.update({
                where: { name: channelName },
                data: {
                    label,
                    avatarUrl,
                    newFiles: scan.newFiles,
                    totalSize: scan.totalSize,
                    totalSizeBytes: scan.totalSizeBytes,
                    maxId: scan.maxId,
                    hasError: false,
                    errorMessage: null,
                    lastCheckedAt: new Date()
                }
            });

            console.info(`[Telegram Checker] Sincronización exitosa: ${channelName} | ${scan.newFiles} archivos nuevos (${scan.totalSize})`);
        } catch (error) {
            console.error(`[Telegram Checker] Error sincronizando canal ${channelName}:`, error.message);
            
            try {
                await prisma.telegramChannel.update({
                    where: { name: channelName },
                    data: {
                        lastCheckedAt: new Date(),
                        hasError: true,
                        errorMessage: error.message
                    }
                });
            } catch (dbErr) {
                console.error('[Telegram Checker] Error guardando estado de error en BD:', dbErr);
            }

            // Si es un error de FloodWait de Telegram, capturamos los segundos para pausar el worker
            if (error.message && error.message.includes('FLOOD_WAIT_')) {
                const match = error.message.match(/FLOOD_WAIT_(\d+)/);
                if (match) {
                    const waitSeconds = parseInt(match[1]) || 60;
                    console.warn(`[Telegram Checker] Detectado FLOOD_WAIT. Pausando el checker por ${waitSeconds + 10} segundos.`);
                    await this.scheduleNextCheck((waitSeconds + 10) * 1000);
                }
            }
        }
    }
}

export default new TelegramCheckerService();

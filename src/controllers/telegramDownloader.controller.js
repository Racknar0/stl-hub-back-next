import fs from 'fs';
import path from 'path';
import telegramDownloaderService from '../services/telegramDownloader.service.js';
import telegramCheckerService from '../services/telegramChecker.service.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const formatDbDate = (d) => {
    if (!d) return null;
    const now = new Date(d);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
};

function mapChannelToFrontend(c) {
    return {
        name: c.name,
        label: c.label || '',
        avatarUrl: c.avatarUrl || null,
        addedAt: c.addedAt.toISOString(),
        lastCheckedAt: c.lastCheckedAt ? c.lastCheckedAt.toISOString() : null,
        lastScanResult: {
            newFiles: c.newFiles,
            totalSize: c.totalSize || '0 B',
            totalSizeBytes: Number(c.totalSizeBytes),
            maxId: c.maxId,
            error: c.hasError,
            errorMessage: c.errorMessage || null
        },
        lastDownload: c.lastMsgId ? {
            lastMsgId: c.lastMsgId,
            lastFileName: c.lastFileName || '',
            lastDownloadedAt: formatDbDate(c.lastDownloadedAt),
            url: c.lastDownloadUrl || ''
        } : null
    };
}

export const checkAuth = async (req, res) => {
    try {
        const isAuth = await telegramDownloaderService.checkAuth();
        res.json({ success: true, isAuthorized: isAuth });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const logout = async (req, res) => {
    try {
        await telegramDownloaderService.logout();
        res.json({ success: true, message: 'Sesión cerrada' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const clearDownloads = (req, res) => {
    try {
        const count = telegramDownloaderService.clearDownloads();
        res.json({ success: true, message: `${count} archivos eliminados` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const startAuth = async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number required' });
        
        telegramDownloaderService.startAuth(phoneNumber);
        res.json({ success: true, message: 'Auth started, waiting for code' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const provideCode = (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code required' });
    telegramDownloaderService.provideCode(code);
    res.json({ success: true, message: 'Code provided' });
};

export const providePassword = (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Password required' });
    telegramDownloaderService.providePassword(password);
    res.json({ success: true, message: 'Password provided' });
};

export const listChannels = async (req, res) => {
    try {
        const channels = await prisma.telegramChannel.findMany({
            orderBy: { name: 'asc' }
        });
        const enriched = channels.map(mapChannelToFrontend);
        res.json({ success: true, channels: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const addChannel = async (req, res) => {
    try {
        const { name, label, lastMsgId } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

        let channel = await prisma.telegramChannel.findUnique({ where: { name } });
        if (!channel) {
            channel = await prisma.telegramChannel.create({
                data: {
                    name,
                    label: label || '',
                    avatarUrl: null
                }
            });
        }

        if (lastMsgId !== undefined && lastMsgId !== null && lastMsgId !== '') {
            await telegramDownloaderService.saveLastDownload(name, Number(lastMsgId), 'Inicialización manual');
        }

        // Si Telegram está autenticado, intentar sincronizar de inmediato
        const isAuth = await telegramDownloaderService.checkAuth();
        if (isAuth) {
            try {
                await telegramCheckerService.syncChannelData(name);
            } catch (syncErr) {
                console.error('[Telegram Controller] Error sincronizando canal nuevo:', syncErr);
            }
        }

        // Retornar listado de canales enriquecido
        const updatedChannels = await prisma.telegramChannel.findMany({
            orderBy: { name: 'asc' }
        });
        const enriched = updatedChannels.map(mapChannelToFrontend);

        res.json({ success: true, channels: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateChannel = async (req, res) => {
    try {
        const { name } = req.params;
        const { label, newName, lastMsgId } = req.body;
        const channel = await prisma.telegramChannel.findUnique({ where: { name } });
        if (!channel) return res.status(404).json({ success: false, message: 'Channel not found' });

        const data = {};
        if (label !== undefined) data.label = label;
        
        if (newName && newName !== name) {
            // Renombrar archivo de avatar si existe
            const oldAvatarPath = path.join(process.cwd(), 'uploads', 'telegram_avatars', `${name}.jpg`);
            const newAvatarPath = path.join(process.cwd(), 'uploads', 'telegram_avatars', `${newName}.jpg`);
            if (fs.existsSync(oldAvatarPath)) {
                try {
                    fs.renameSync(oldAvatarPath, newAvatarPath);
                    data.avatarUrl = `/uploads/telegram_avatars/${newName}.jpg`;
                } catch (err) {
                    console.error('[Telegram Controller] Error renombrando avatar:', err);
                }
            } else if (channel.avatarUrl && channel.avatarUrl.includes(name)) {
                data.avatarUrl = `/uploads/telegram_avatars/${newName}.jpg`;
            }
            data.name = newName;
        }

        if (lastMsgId !== undefined && lastMsgId !== null && lastMsgId !== '') {
            const targetName = newName || name;
            await telegramDownloaderService.saveLastDownload(targetName, Number(lastMsgId), 'Modificado manualmente');
        }

        if (Object.keys(data).length > 0) {
            await prisma.telegramChannel.update({
                where: { name },
                data
            });
        }

        // Re-enrich
        const updatedChannels = await prisma.telegramChannel.findMany({
            orderBy: { name: 'asc' }
        });
        const enriched = updatedChannels.map(mapChannelToFrontend);
        res.json({ success: true, channels: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const quickScan = async (req, res) => {
    try {
        const { channelName } = req.query;
        if (!channelName) return res.status(400).json({ success: false, message: 'channelName required' });

        broadcastToClients({ type: 'scan_start', channelName });
        
        await telegramCheckerService.syncChannelData(channelName, (prog) => {
            broadcastToClients(prog);
        });
        
        broadcastToClients({ type: 'scan_finish', channelName });

        const chan = await prisma.telegramChannel.findUnique({ where: { name: channelName } });
        if (!chan) {
            return res.status(404).json({ success: false, message: 'Channel not found after sync' });
        }

        res.json({
            success: true,
            newFiles: chan.newFiles ?? 0,
            totalMessages: chan.maxId ?? 0,
            totalSize: chan.totalSize ?? '0 B',
            totalSizeBytes: Number(chan.totalSizeBytes ?? 0),
            maxId: chan.maxId ?? 0
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteChannel = async (req, res) => {
    try {
        const { name } = req.params;
        await prisma.telegramChannel.delete({ where: { name } });
        const channels = await prisma.telegramChannel.findMany({
            orderBy: { name: 'asc' }
        });
        const enriched = channels.map(mapChannelToFrontend);
        res.json({ success: true, channels: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getChannelInfo = async (req, res) => {
    try {
        const { channelName, maxGB } = req.query;
        if (!channelName) return res.status(400).json({ success: false, message: 'Channel name required' });
        
        const info = await telegramDownloaderService.getChannelInfo(channelName, Number(maxGB) || 150);
        res.json({ success: true, info });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const scanWithLimit = async (req, res) => {
    try {
        const { channelName, startId, maxGB } = req.query;
        if (!channelName || !startId) return res.status(400).json({ success: false, message: 'Faltan parámetros' });
        
        broadcastToClients({ type: 'scan_start', channelName });
        
        const result = await telegramDownloaderService.scanWithLimit(
            channelName, 
            Number(startId), 
            Number(maxGB) || 150,
            (prog) => {
                broadcastToClients(prog);
            }
        );
        
        broadcastToClients({ type: 'scan_finish', channelName });
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const startDownload = async (req, res) => {
    try {
        const { channelName, startId, endId } = req.body;
        if (!channelName || !startId || !endId) {
            return res.status(400).json({ success: false, message: 'Faltan parámetros' });
        }

        if (telegramDownloaderService.isDownloading) {
            return res.status(400).json({ success: false, message: 'Ya hay una descarga en progreso' });
        }

        // We run it asynchronously so it doesn't block the request
        telegramDownloaderService.startDownload({
            channelName,
            startId: Number(startId),
            endId: Number(endId)
        }, (progressData) => {
            // Emite a todos los clientes SSE conectados
            clients.forEach(client => {
                client.write(`data: ${JSON.stringify(progressData)}\n\n`);
            });
        }).catch(err => {
            console.error('Error in background download:', err);
        });

        res.json({ success: true, message: 'Descarga iniciada' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const cancelDownload = (req, res) => {
    telegramDownloaderService.cancelDownload();
    res.json({ success: true, message: 'Cancelación solicitada' });
};

export const downloadStatus = (req, res) => {
    const state = telegramDownloaderService.getReconnectState();
    res.json({ success: true, ...state });
};

// --- SSE (Server-Sent Events) ---
let clients = [];

export const streamProgress = (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    clients.push(res);
    
    // Send full state for reconnecting clients
    if (telegramDownloaderService.isDownloading) {
        const state = telegramDownloaderService.getReconnectState();
        
        // Replay log buffer so client can rebuild its log panel
        for (const logEntry of state.logBuffer) {
            res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
        }
        
        // Send last progress so bars update immediately
        if (state.lastProgress) {
            res.write(`data: ${JSON.stringify({ ...state.lastProgress, active: true })}\n\n`);
        } else {
            res.write(`data: ${JSON.stringify({ type: 'info', message: 'Descarga en progreso...', active: true })}\n\n`);
        }
    }

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
};

import fs from 'fs';
import path from 'path';
import telegramDownloaderService from '../services/telegramDownloader.service.js';

const CHANNELS_FILE = path.join(process.cwd(), 'data', 'telegram_channels.json');

// Helper para leer canales
function getChannels() {
    if (!fs.existsSync(CHANNELS_FILE)) {
        if (!fs.existsSync(path.dirname(CHANNELS_FILE))) {
            fs.mkdirSync(path.dirname(CHANNELS_FILE), { recursive: true });
        }
        fs.writeFileSync(CHANNELS_FILE, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
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

export const listChannels = (req, res) => {
    try {
        const channels = getChannels();
        const allLastDownloads = telegramDownloaderService.getLastDownloads();
        
        // Enrich each channel with its last download info
        const enriched = channels.map(c => ({
            ...c,
            lastDownload: allLastDownloads[c.name] || null
        }));
        
        res.json({ success: true, channels: enriched });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const addChannel = (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

        const channels = getChannels();
        if (!channels.find(c => c.name === name)) {
            channels.push({ name, addedAt: new Date().toISOString() });
            fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));
        }
        res.json({ success: true, channels });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteChannel = (req, res) => {
    try {
        const { name } = req.params;
        let channels = getChannels();
        channels = channels.filter(c => c.name !== name);
        fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));
        res.json({ success: true, channels });
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
        
        const result = await telegramDownloaderService.scanWithLimit(channelName, Number(startId), Number(maxGB) || 150);
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

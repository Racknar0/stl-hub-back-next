import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { SEVEN_ZIP } from '../../utils/archiveExtractor.js';

const router = express.Router();

const SOURCE_DIR = path.join(process.cwd(), 'uploads', 'telegram_downloads');
const TARGET_DIR = path.join(process.cwd(), 'uploads', 'telegram_downloads_organized');

const ARCHIVE_REGEX = /\.(rar|zip|7z|stl|obj)($|\.\d+$)/i;
const IMAGE_REGEX = /\.(png|jpg|jpeg|gif|webp)$/i;

// Solo nombres de archivo planos (sin '/', '\\' ni '..'): evita salir de la carpeta (path traversal)
const isSafeName = (name) =>
    typeof name === 'string' && name !== '' && name !== '.' && name !== '..'
    && !name.includes('\0') && !name.includes('\\') && path.basename(name) === name;

// La carpeta de un paquete debe ser hija directa de TARGET_DIR
const resolvePackageFolder = (folder) => {
    if (typeof folder !== 'string' || !folder) return null;
    const resolved = path.resolve(TARGET_DIR, folder);
    return path.dirname(resolved) === TARGET_DIR ? resolved : null;
};

// Orden total (desempate exacto) para que el cursor `after` sea estable
const compareNames = (a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

// Listado en caché unos segundos: antes se releía y ordenaba toda la carpeta (con un stat por archivo)
// en cada petición. Las rutas que cambian archivos llaman a invalidateListing(); el TTL cubre lo que
// añade el downloader de Telegram por su cuenta.
const LISTING_TTL_MS = 5000;
let listingCache = null; // { at, result }
let listingInFlight = null;
let listingGeneration = 0; // si se invalida durante una lectura, ese resultado no se guarda
const invalidateListing = () => { listingCache = null; listingGeneration++; };

const readListing = async () => {
    const entries = await fs.promises.readdir(SOURCE_DIR, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        if (!entry.isFile() || entry.name === '.gitkeep') continue;
        const f = entry.name;
        const lower = f.toLowerCase();
        if (IMAGE_REGEX.test(lower)) {
            result.push({ name: f, type: 'image' });
        } else if (ARCHIVE_REGEX.test(lower)) {
            const isCompressed = /\.(rar|zip|7z)($|\.\d+$)/i.test(lower);
            result.push({ name: f, type: 'anchor', isCompressed });
        }
    }
    result.sort((a, b) => compareNames(a.name, b.name));
    return result;
};

const getListing = async () => {
    if (listingCache && Date.now() - listingCache.at < LISTING_TTL_MS) return listingCache.result;
    const generation = listingGeneration;
    if (!listingInFlight || listingInFlight.generation !== generation) {
        const promise = readListing()
            .then(result => {
                if (generation === listingGeneration) listingCache = { at: Date.now(), result };
                return result;
            })
            .finally(() => { if (listingInFlight === promise) listingInFlight = null; });
        promise.generation = generation;
        listingInFlight = promise;
    }
    return listingInFlight;
};

// List files paginated
router.get('/files', async (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 200;

    if (!fs.existsSync(SOURCE_DIR)) {
        return res.json({ files: [], total: 0, totalAssets: 0, totalImages: 0 });
    }

    try {
        const result = await getListing();

        const totalAssets = result.filter(f => f.type === 'anchor').length;
        const totalImages = result.length - totalAssets;

        // `after` = último nombre que ya tiene el cliente. A diferencia de `offset`, no se descuadra
        // cuando se empaquetan o borran archivos entre una página y la siguiente.
        const after = typeof req.query.after === 'string' ? req.query.after : null;
        let start = offset;
        if (after) {
            start = result.findIndex(f => compareNames(f.name, after) > 0);
            if (start === -1) start = result.length;
        }
        const page = result.slice(start, start + limit);

        res.json({ files: page, total: result.length, totalAssets, totalImages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Serve image
router.get('/image', (req, res) => {
    const { name } = req.query;
    if (!name) return res.sendStatus(400);
    const filePath = path.join(SOURCE_DIR, path.basename(name));
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    // La grilla virtualizada desmonta/monta las fotos al hacer scroll: que el navegador las tenga en caché
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(filePath);
});

// Package selection
router.post('/package', (req, res) => {
    const { anchorName, filesToMove } = req.body;
    if (!anchorName || !filesToMove || !Array.isArray(filesToMove)) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }
    if (!isSafeName(anchorName) || !filesToMove.every(isSafeName)) {
        return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }

    try {
        if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

        const cleanName = (filename) => {
            let ext = path.extname(filename);
            let base = path.basename(filename, ext);

            const matchSplit = filename.match(/(\.(?:rar|zip|7z))(\.\d+)$/i);
            if (matchSplit) {
                ext = matchSplit[1] + matchSplit[2];
                base = filename.slice(0, -ext.length);
            }

            base = base.replace(/^(?:[\w-]+_)?\d+_/, '');
            base = base.replace(/@\S+/g, '');
            base = base.trim();
            if (!base) base = 'asset_desconocido';
            return { base, ext };
        };

        const isArchiveFile = (fname) => ARCHIVE_REGEX.test(fname.toLowerCase());

        const { base: cleanAssetBase, ext: anchorExt } = cleanName(anchorName);
        let folderName = cleanAssetBase;
        let destFolder = path.join(TARGET_DIR, folderName);

        let counter = 1;
        while (fs.existsSync(destFolder)) {
            folderName = `${cleanAssetBase} ${counter}`;
            destFolder = path.join(TARGET_DIR, folderName);
            counter++;
        }

        fs.mkdirSync(destFolder, { recursive: true });

        const mappings = [];
        let movedCount = 0;
        for (const file of filesToMove) {
            const srcFile = path.join(SOURCE_DIR, file);
            let destFilename = file;

            if (file === anchorName) {
                destFilename = folderName + anchorExt;
            } else if (isArchiveFile(file)) {
                const { base: cleanBase, ext: cleanExt } = cleanName(file);
                destFilename = cleanBase + cleanExt;
                let counterPart = 1;
                let testPath = path.join(destFolder, destFilename);
                while (fs.existsSync(testPath)) {
                    destFilename = `${cleanBase} ${counterPart}${cleanExt}`;
                    testPath = path.join(destFolder, destFilename);
                    counterPart++;
                }
            }

            const destFile = path.join(destFolder, destFilename);
            if (fs.existsSync(srcFile)) {
                fs.renameSync(srcFile, destFile);
                mappings.push({ original: file, current: destFilename });
                movedCount++;
            }
        }

        invalidateListing();
        res.json({ success: true, moved: movedCount, folder: folderName, destFolder, mappings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete file (move to .trash)
router.post('/delete-file', (req, res) => {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ error: 'Falta fileName' });
    if (!isSafeName(fileName)) return res.status(400).json({ error: 'Nombre de archivo inválido' });

    const filePath = path.join(SOURCE_DIR, fileName);
    const trashDir = path.join(SOURCE_DIR, '.trash');
    const trashPath = path.join(trashDir, fileName);

    try {
        if (fs.existsSync(filePath)) {
            if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir);
            fs.renameSync(filePath, trashPath);
            invalidateListing();
            return res.json({ success: true });
        }
        return res.status(404).json({ error: 'Archivo no encontrado' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Delete files por lotes (move to .trash): una sola petición; informa cuáles fallaron
router.post('/delete-files', (req, res) => {
    const { fileNames } = req.body;
    if (!Array.isArray(fileNames) || fileNames.length === 0) {
        return res.status(400).json({ error: 'Falta fileNames' });
    }

    const trashDir = path.join(SOURCE_DIR, '.trash');
    const deleted = [];
    const failed = [];
    const missing = []; // ya no estaban (otro borrado/empaquetado): no hay que devolverlos a la grilla
    try {
        if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    for (const fileName of fileNames) {
        if (!isSafeName(fileName)) {
            failed.push({ name: String(fileName), error: 'Nombre de archivo inválido' });
            continue;
        }
        try {
            const filePath = path.join(SOURCE_DIR, fileName);
            if (!fs.existsSync(filePath)) {
                missing.push(fileName);
                continue;
            }
            fs.renameSync(filePath, path.join(trashDir, fileName));
            deleted.push(fileName);
        } catch (err) {
            failed.push({ name: fileName, error: err.message });
        }
    }

    invalidateListing();
    res.json({ success: failed.length === 0, deleted, failed, missing });
});

// Undo
router.post('/undo', (req, res) => {
    const { type, destFolder: rawDestFolder, mappings, files } = req.body;
    const restored = []; // nombres originales que han vuelto a SOURCE_DIR (el front los reinserta sin recargar)
    try {
        if (type === 'package') {
            const destFolder = resolvePackageFolder(rawDestFolder);
            const validMappings = Array.isArray(mappings) && mappings.every(m => isSafeName(m?.current) && isSafeName(m?.original));
            if (!destFolder || !validMappings) {
                return res.status(400).json({ error: 'Datos de deshacer inválidos' });
            }
            for (const m of mappings) {
                const currentPath = path.join(destFolder, m.current);
                const originalPath = path.join(SOURCE_DIR, m.original);
                if (fs.existsSync(currentPath)) {
                    fs.renameSync(currentPath, originalPath);
                    restored.push(m.original);
                }
            }
            if (fs.existsSync(destFolder) && fs.readdirSync(destFolder).length === 0) {
                fs.rmdirSync(destFolder);
            }
        } else if (type === 'delete') {
            if (!Array.isArray(files) || !files.every(isSafeName)) {
                return res.status(400).json({ error: 'Datos de deshacer inválidos' });
            }
            const trashDir = path.join(SOURCE_DIR, '.trash');
            for (const f of (files || [])) {
                const trashPath = path.join(trashDir, f);
                const originalPath = path.join(SOURCE_DIR, f);
                if (fs.existsSync(trashPath)) {
                    fs.renameSync(trashPath, originalPath);
                    restored.push(f);
                }
            }
        }
        invalidateListing();
        res.json({ success: true, restored });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Vista previa de un asset (contenido del comprimido) ──────────────────────
// /archive/list lista lo que hay dentro sin extraer nada; /archive/entry saca un solo archivo por stdout
// (7z e -so, o unrar p si el 7z del VPS no soporta ese RAR) y lo manda tal cual al navegador.
const COMPRESSED_REGEX = /\.(rar|zip|7z)($|\.\d+$)/i;
const PREVIEW_MAX_BYTES = 512 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 2 * 60 * 1000;
const ENTRY_TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.nfo': 'text/plain; charset=utf-8',
};

// Junta toda la salida de un proceso (para los listados)
const runCapture = (cmd, args) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, PREVIEW_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Spawn error: ${e.message}`)); });
    child.on('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve(out) : reject(new Error((err || out).trim().slice(0, 300) || `${cmd} exited ${code}`));
    });
});

// Bloques "clave = valor" de `7z l -slt`; el primero (antes de "----------") describe el propio comprimido
const parse7zListing = (out) => {
    const body = out.split(/^-{5,}\s*$/m).slice(1).join('\n');
    const entries = [];
    for (const block of body.split(/\r?\n\s*\r?\n/)) {
        const fields = {};
        for (const line of block.split(/\r?\n/)) {
            const m = line.match(/^([^=]+?) = (.*)$/);
            if (m) fields[m[1].trim()] = m[2];
        }
        if (!fields.Path) continue;
        const isDir = fields.Folder === '+' || /^D/.test(fields.Attributes || '');
        entries.push({ raw: fields.Path, size: Number(fields.Size) || 0, isDir });
    }
    return entries;
};

// Bloques "Clave: valor" de `unrar lt`
const parseUnrarListing = (out) => {
    const entries = [];
    for (const block of out.split(/\r?\n\s*\r?\n/)) {
        const fields = {};
        for (const line of block.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z ]+): (.*)$/);
            if (m) fields[m[1].trim()] = m[2];
        }
        if (!fields.Name || !fields.Type) continue;
        entries.push({ raw: fields.Name, size: Number(fields.Size) || 0, isDir: /directory/i.test(fields.Type) });
    }
    return entries;
};

// Pocos listados en memoria: al ir pinchando archivos del mismo comprimido no se vuelve a listar
const archiveListCache = new Map(); // `${name}|${mtimeMs}` → { entries, tool }
const ARCHIVE_LIST_CACHE_MAX = 20;

const listArchive = async (name, filePath) => {
    const stat = await fs.promises.stat(filePath);
    const key = `${name}|${stat.mtimeMs}`;
    if (archiveListCache.has(key)) return archiveListCache.get(key);

    let result;
    try {
        const out = await runCapture(SEVEN_ZIP, ['l', '-slt', '-p-', filePath]);
        result = { entries: parse7zListing(out), tool: '7z' };
    } catch (e7z) {
        if (!/\.rar($|\.\d+$)/i.test(name)) throw e7z;
        try {
            const out = await runCapture('unrar', ['lt', '-p-', filePath]);
            result = { entries: parseUnrarListing(out), tool: 'unrar' };
        } catch (eRar) {
            throw new Error(`7z: ${e7z.message.slice(0, 150)} | unrar: ${eRar.message.slice(0, 150)}`);
        }
    }
    for (const entry of result.entries) entry.path = entry.raw.replace(/\\/g, '/');
    archiveListCache.set(key, result);
    if (archiveListCache.size > ARCHIVE_LIST_CACHE_MAX) archiveListCache.delete(archiveListCache.keys().next().value);
    return result;
};

// Manda por la respuesta el stdout del proceso. Si falla antes de mandar nada, rechaza (para probar otra herramienta).
const streamEntry = (cmd, args, req, res, contentType) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let started = false, err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, PREVIEW_TIMEOUT_MS);
    // Si el usuario cambia de archivo o cierra el modal, no seguir extrayendo
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    res.on('close', onAbort);
    child.stderr.on('data', d => { err += d.toString(); });
    child.stdout.on('data', chunk => {
        if (!started) {
            started = true;
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'private, max-age=3600');
        }
        if (!res.write(chunk)) {
            child.stdout.pause();
            res.once('drain', () => child.stdout.resume());
        }
    });
    child.on('error', e => { clearTimeout(timer); res.off('close', onAbort); if (!started) reject(new Error(`Spawn error: ${e.message}`)); else res.end(); });
    child.on('close', code => {
        clearTimeout(timer);
        res.off('close', onAbort);
        if (started) { res.end(); return resolve(); }
        if (code === 0) { res.set('Content-Type', contentType); res.end(); return resolve(); } // archivo vacío
        reject(new Error(err.trim().slice(0, 300) || `${cmd} exited ${code}`));
    });
});

router.get('/archive/list', async (req, res) => {
    const { name } = req.query;
    if (!isSafeName(name)) return res.status(400).json({ error: 'Nombre inválido' });
    const filePath = path.join(SOURCE_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'El archivo ya no existe' });
    try {
        if (!COMPRESSED_REGEX.test(name)) {
            // .stl / .obj suelto: el "contenido" es el propio archivo
            const stat = await fs.promises.stat(filePath);
            return res.json({ entries: [{ path: name, size: stat.size, isDir: false }], direct: true });
        }
        const { entries } = await listArchive(name, filePath);
        res.json({ entries: entries.map(({ path: p, size, isDir }) => ({ path: p, size, isDir })), direct: false });
    } catch (err) {
        const msg = String(err.message || err);
        const encrypted = /wrong password|encrypted|password/i.test(msg);
        res.status(422).json({ error: encrypted ? 'El archivo tiene contraseña' : `No se pudo leer el comprimido: ${msg}` });
    }
});

router.get('/archive/entry', async (req, res) => {
    const { name, entry } = req.query;
    if (!isSafeName(name) || typeof entry !== 'string' || !entry) return res.sendStatus(400);
    const filePath = path.join(SOURCE_DIR, name);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
    const ext = path.extname(entry).toLowerCase();
    const contentType = ENTRY_TYPES[ext] || 'application/octet-stream';

    if (!COMPRESSED_REGEX.test(name)) {
        if (entry !== name) return res.sendStatus(404);
        res.set('Content-Type', contentType);
        return res.sendFile(filePath);
    }

    try {
        const { entries, tool } = await listArchive(name, filePath);
        // Solo se extraen rutas que salen en el listado (y se usa la ruta tal cual la escribe 7z)
        const found = entries.find(e => !e.isDir && e.path === entry);
        if (!found) return res.sendStatus(404);
        if (found.size > PREVIEW_MAX_BYTES) return res.status(413).json({ error: 'Archivo demasiado grande para la vista previa' });
        if (found.raw.startsWith('-')) return res.sendStatus(400);

        const viaUnrar = () => streamEntry('unrar', ['p', '-inul', '-p-', filePath, found.raw], req, res, contentType);
        if (tool === 'unrar') return await viaUnrar();
        try {
            // -spd: la ruta es literal (sin comodines * ?)
            await streamEntry(SEVEN_ZIP, ['e', '-so', '-spd', '-p-', '-y', filePath, found.raw], req, res, contentType);
        } catch (e7z) {
            if (!/\.rar($|\.\d+$)/i.test(name)) throw e7z;
            await viaUnrar();
        }
    } catch (err) {
        if (!res.headersSent) res.status(422).json({ error: `No se pudo extraer: ${String(err.message || err).slice(0, 300)}` });
    }
});

// Purge SOURCE_DIR (remove all orphan files)
router.delete('/purge', (req, res) => {
    // Confirmación explícita: evita que una llamada accidental vacíe la carpeta (y la papelera de Deshacer)
    if (req.query.confirm !== 'PURGAR') {
        return res.status(400).json({ success: false, message: 'Falta confirmación (confirm=PURGAR)' });
    }
    try {
        if (!fs.existsSync(SOURCE_DIR)) {
            return res.json({ success: true, message: 'La carpeta ya está vacía.' });
        }

        const entries = fs.readdirSync(SOURCE_DIR);
        for (const entry of entries) {
            const entryPath = path.join(SOURCE_DIR, entry);
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
        invalidateListing();

        res.json({ success: true, message: 'Carpeta purgada correctamente.' });
    } catch (error) {
        console.error('Error purging source directory:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Papelera (.trash, de donde sale "Deshacer" de los borrados): se vacía sola lo que lleve más de 2 días.
// Se usa ctime porque mover el archivo a .trash (rename) actualiza el ctime pero conserva el mtime original.
const TRASH_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const TRASH_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const cleanOldTrash = async () => {
    const trashDir = path.join(SOURCE_DIR, '.trash');
    let entries;
    try {
        entries = await fs.promises.readdir(trashDir, { withFileTypes: true });
    } catch {
        return 0; // no hay papelera
    }
    const limit = Date.now() - TRASH_MAX_AGE_MS;
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(trashDir, entry.name);
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.ctimeMs < limit) {
                await fs.promises.rm(filePath, { force: true });
                removed++;
            }
        } catch (err) {
            console.warn(`[ORGANIZER][TRASH] No se pudo limpiar ${entry.name}: ${err.message}`);
        }
    }
    if (removed > 0) console.log(`[ORGANIZER][TRASH] ${removed} archivos de más de 2 días eliminados de la papelera`);
    return removed;
};

setTimeout(() => cleanOldTrash().catch(() => {}), 60 * 1000).unref();
setInterval(() => cleanOldTrash().catch(() => {}), TRASH_CLEAN_INTERVAL_MS).unref();

export default router;

import express from 'express';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

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

// Miniaturas webp (~320px) generadas con sharp y guardadas en SOURCE_DIR/.thumbs (Purgar las borra).
// Antes cada tarjeta descargaba la imagen original (~240KB); la miniatura pesa ~10-20KB.
const THUMB_DIR = path.join(SOURCE_DIR, '.thumbs');
const THUMB_WIDTH = 320;
const thumbJobs = new Map(); // evita generar dos veces la misma miniatura en paralelo
const thumbPath = (name) => path.join(THUMB_DIR, `${name}.webp`);
const removeThumb = (name) => { try { fs.rmSync(thumbPath(name), { force: true }); } catch {} };

router.get('/thumb', async (req, res) => {
    const { name } = req.query;
    if (!isSafeName(name) || !IMAGE_REGEX.test(name.toLowerCase())) return res.sendStatus(400);

    const src = path.join(SOURCE_DIR, name);
    const thumb = thumbPath(name);
    const srcStat = await fs.promises.stat(src).catch(() => null);
    if (!srcStat) return res.sendStatus(404);

    try {
        const thumbStat = await fs.promises.stat(thumb).catch(() => null);
        if (!thumbStat || thumbStat.mtimeMs < srcStat.mtimeMs) {
            if (!thumbJobs.has(thumb)) {
                thumbJobs.set(thumb, (async () => {
                    await fs.promises.mkdir(THUMB_DIR, { recursive: true });
                    const tmp = `${thumb}.${process.pid}.${Date.now()}.tmp`;
                    await sharp(src, { failOn: 'none' })
                        .rotate()
                        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
                        .webp({ quality: 72 })
                        .toFile(tmp);
                    await fs.promises.rename(tmp, thumb);
                })().finally(() => thumbJobs.delete(thumb)));
            }
            await thumbJobs.get(thumb);
        }
        res.set('Cache-Control', 'private, max-age=604800');
        res.type('image/webp');
        return res.sendFile(thumb);
    } catch (err) {
        // Imagen rara o corrupta: servir el original para no dejar la tarjeta vacía
        console.warn(`[ORGANIZER][THUMB] ${name}: ${err.message}`);
        return res.sendFile(src);
    }
});

// Serve image
router.get('/image', (req, res) => {
    const { name } = req.query;
    if (!name) return res.sendStatus(400);
    const filePath = path.join(SOURCE_DIR, path.basename(name));
    if (!fs.existsSync(filePath)) return res.sendStatus(404);
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
                removeThumb(file);
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
            removeThumb(fileName);
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
            removeThumb(fileName);
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

export default router;

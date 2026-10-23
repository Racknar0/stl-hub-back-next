import express from 'express';
import fs from 'fs';
import path from 'path';

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

// List files paginated
router.get('/files', (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 200;

    if (!fs.existsSync(SOURCE_DIR)) {
        return res.json({ files: [], total: 0, totalAssets: 0, totalImages: 0 });
    }

    try {
        const allEntries = fs.readdirSync(SOURCE_DIR);
        const result = [];

        for (const f of allEntries) {
            const fullPath = path.join(SOURCE_DIR, f);
            if (fs.statSync(fullPath).isDirectory()) continue;
            if (f === '.gitkeep') continue;

            const lower = f.toLowerCase();
            if (IMAGE_REGEX.test(lower)) {
                result.push({ name: f, type: 'image' });
            } else if (ARCHIVE_REGEX.test(lower)) {
                const isCompressed = /\.(rar|zip|7z)($|\.\d+$)/i.test(lower);
                result.push({ name: f, type: 'anchor', isCompressed });
            }
        }

        result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        const totalAssets = result.filter(f => f.type === 'anchor').length;
        const totalImages = result.length - totalAssets;
        const page = result.slice(offset, offset + limit);

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
            return res.json({ success: true });
        }
        return res.status(404).json({ error: 'Archivo no encontrado' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Undo
router.post('/undo', (req, res) => {
    const { type, destFolder: rawDestFolder, mappings, files } = req.body;
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
                if (fs.existsSync(currentPath)) fs.renameSync(currentPath, originalPath);
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
                if (fs.existsSync(trashPath)) fs.renameSync(trashPath, originalPath);
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Purge SOURCE_DIR (remove all orphan files)
router.delete('/purge', (req, res) => {
    try {
        if (!fs.existsSync(SOURCE_DIR)) {
            return res.json({ success: true, message: 'La carpeta ya está vacía.' });
        }

        const entries = fs.readdirSync(SOURCE_DIR);
        for (const entry of entries) {
            const entryPath = path.join(SOURCE_DIR, entry);
            fs.rmSync(entryPath, { recursive: true, force: true });
        }

        res.json({ success: true, message: 'Carpeta purgada correctamente.' });
    } catch (error) {
        console.error('Error purging source directory:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;

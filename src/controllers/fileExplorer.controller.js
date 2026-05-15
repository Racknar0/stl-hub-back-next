import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);
const UPLOADS_DIR = path.resolve('uploads');

const getFolderSize = async (dirPath) => {
    if (process.platform === 'win32') return 0; // Skip on Windows dev
    try {
        const { stdout } = await execAsync(`du -sb "${dirPath}"`);
        return parseInt(stdout.split(/\s+/)[0], 10) || 0;
    } catch (e) {
        return 0;
    }
};

const resolveSafePath = (relativePath) => {
    const safeRelativePath = relativePath || '/';
    const absolutePath = path.resolve(UPLOADS_DIR, `.${safeRelativePath}`);
    if (!absolutePath.startsWith(UPLOADS_DIR)) {
        throw new Error('Acceso denegado. Ruta fuera de los límites permitidos.');
    }
    return absolutePath;
};

const mapToFileData = async (dirent, currentPath) => {
    const isDir = dirent.isDirectory();
    const filePath = path.join(resolveSafePath(currentPath), dirent.name);
    let size = 0;
    let modDate = null;

    try {
        const stats = fs.statSync(filePath);
        size = stats.size;
        modDate = stats.mtime;

        if (isDir && currentPath === '/') {
            // Only calculate folder size deeply for root folders
            size = await getFolderSize(filePath);
        } else if (isDir) {
            size = 0; // Don't show size for nested folders
        }
    } catch (err) {}

    const id = path.posix.join(currentPath === '/' ? '' : currentPath, dirent.name);

    return {
        id,
        name: dirent.name,
        isDir,
        size,
        modDate: modDate ? modDate.toISOString() : undefined,
    };
};

export const listDirectory = async (req, res) => {
    try {
        let folderPath = req.query.path || '/';
        if (!folderPath.startsWith('/')) folderPath = '/' + folderPath;

        const absolutePath = resolveSafePath(folderPath);

        if (!fs.existsSync(absolutePath)) {
            return res.status(404).json({ success: false, message: 'Directorio no encontrado' });
        }

        const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
        
        const files = await Promise.all(entries.map(entry => mapToFileData(entry, folderPath)));

        res.json({ success: true, files });
    } catch (error) {
        console.error('[FileExplorer] Error listDirectory:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const createFolder = async (req, res) => {
    try {
        const { currentPath, folderName } = req.body;
        if (!folderName) throw new Error('Nombre de carpeta requerido');

        const absolutePath = resolveSafePath(path.join(currentPath, folderName));
        
        if (!fs.existsSync(absolutePath)) {
            fs.mkdirSync(absolutePath, { recursive: true });
        }

        res.json({ success: true, message: 'Carpeta creada' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteFiles = async (req, res) => {
    try {
        const { files } = req.body; // array of paths (ids)
        if (!Array.isArray(files)) throw new Error('Se requiere un array de archivos');

        for (const fileId of files) {
            const absolutePath = resolveSafePath(fileId);
            if (fs.existsSync(absolutePath)) {
                fs.rmSync(absolutePath, { recursive: true, force: true });
            }
        }

        res.json({ success: true, message: 'Archivos eliminados' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const moveFiles = async (req, res) => {
    try {
        const { files, destination } = req.body;
        if (!Array.isArray(files) || !destination) throw new Error('Parámetros inválidos');

        const destAbsolute = resolveSafePath(destination);
        if (!fs.existsSync(destAbsolute)) throw new Error('Carpeta de destino no existe');

        for (const fileId of files) {
            const sourceAbsolute = resolveSafePath(fileId);
            const fileName = path.basename(sourceAbsolute);
            const targetAbsolute = path.join(destAbsolute, fileName);

            if (fs.existsSync(sourceAbsolute)) {
                fs.renameSync(sourceAbsolute, targetAbsolute);
            }
        }

        res.json({ success: true, message: 'Archivos movidos' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const renameFile = async (req, res) => {
    try {
        const { file, newName } = req.body;
        if (!file || !newName) throw new Error('Parámetros inválidos');

        const sourceAbsolute = resolveSafePath(file);
        const folderAbsolute = path.dirname(sourceAbsolute);
        const targetAbsolute = resolveSafePath(path.join(path.posix.dirname(file), newName));

        if (fs.existsSync(sourceAbsolute)) {
            fs.renameSync(sourceAbsolute, targetAbsolute);
        }

        res.json({ success: true, message: 'Archivo renombrado' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const previewFile = async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).send('Ruta requerida');
        
        const absolutePath = resolveSafePath(filePath);
        if (!fs.existsSync(absolutePath)) {
            return res.status(404).send('No encontrado');
        }

        res.sendFile(absolutePath);
    } catch (error) {
        res.status(500).send('Error');
    }
};

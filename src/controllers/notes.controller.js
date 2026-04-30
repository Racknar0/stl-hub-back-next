import fs from 'fs/promises';
import path from 'path';

// Asegurarse de que exista el archivo en la carpeta data
const dataPath = path.join(process.cwd(), 'data');
const notesFile = path.join(dataPath, 'sticky-notes.json');

const ensureFileExists = async () => {
    try {
        await fs.access(notesFile);
    } catch {
        try {
            await fs.mkdir(dataPath, { recursive: true });
        } catch (e) {
            // Ignorar si ya existe
        }
        await fs.writeFile(notesFile, JSON.stringify({ content: '' }, null, 2), 'utf-8');
    }
};

export const getNote = async (req, res) => {
    try {
        await ensureFileExists();
        const data = await fs.readFile(notesFile, 'utf-8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('Error reading sticky note:', error);
        res.status(500).json({ error: 'Error reading note' });
    }
};

export const saveNote = async (req, res) => {
    try {
        await ensureFileExists();
        const { content } = req.body;
        
        // Guardamos el contenido
        const data = { content: content || '' };
        await fs.writeFile(notesFile, JSON.stringify(data, null, 2), 'utf-8');
        
        res.json({ success: true, data });
    } catch (error) {
        console.error('Error saving sticky note:', error);
        res.status(500).json({ error: 'Error saving note' });
    }
};

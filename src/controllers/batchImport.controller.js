import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const prisma = new PrismaClient();
const UPLOADS_DIR = path.resolve('uploads');
const BATCH_DIR = path.join(UPLOADS_DIR, 'batch_imports');
const ARCHIVE_EXTS = ['.rar', '.zip', '.7z', '.tar', '.gz', '.tgz'];

// Resolver la ruta de 7z según el SO
const SEVEN_ZIP = (() => {
  if (process.platform !== 'win32') return '7z';
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(process.env.LOCALAPPDATA || '', '7-Zip', '7z.exe'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return `"${p}"`; }
  return '7z';
})();

function run7z(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(SEVEN_ZIP, args, { shell: true });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.stderr.on('data', d => (err += d.toString()));
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`7z exited ${code}: ${(err || out).slice(0, 300)}`));
    });
  });
}

// POST /api/batch-imports/scan
export const scanLocalDirectory = async (req, res) => {
  try {
    if (!fs.existsSync(BATCH_DIR)) {
      fs.mkdirSync(BATCH_DIR, { recursive: true });
    }

    // ─── STEP 0: Auto-descomprimir archivos sueltos en batch_imports/ ───
    const topEntries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const topArchives = topEntries
      .filter(e => e.isFile() && ARCHIVE_EXTS.includes(path.extname(e.name).toLowerCase()));

    for (const arc of topArchives) {
      const arcPath = path.join(BATCH_DIR, arc.name);
      const extractDir = path.join(BATCH_DIR, path.parse(arc.name).name);
      console.log(`[BATCH SCAN] Descomprimiendo ${arc.name} → ${extractDir}`);
      try {
        fs.mkdirSync(extractDir, { recursive: true });
        await run7z(['x', arcPath, `-o${extractDir}`, '-y', '-aoa']);
        // Borrar el archivo comprimido original
        fs.unlinkSync(arcPath);
        console.log(`[BATCH SCAN] OK ${arc.name}`);
      } catch (e) {
        console.error(`[BATCH SCAN] Error descomprimiendo ${arc.name}: ${e.message}`);
      }
    }

    // ─── STEP 1: Leer carpetas resultantes ───
    const entries = fs.readdirSync(BATCH_DIR, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory()).map(e => e.name);

    if (folders.length === 0) {
      return res.json({ success: true, message: 'No folders found in batch_imports', count: 0 });
    }

    let newlyQueuedCount = 0;

    for (const folder of folders) {
      // Find or create the master BatchImport record
      let batch = await prisma.batchImport.findUnique({
        where: { folderName: folder }
      });

      if (!batch) {
        batch = await prisma.batchImport.create({
          data: {
            folderName: folder,
            status: 'PENDING'
          }
        });
      }

      // Read subfolders inside this batch folder
      const batchPath = path.join(BATCH_DIR, folder);
      const subEntries = fs.readdirSync(batchPath, { withFileTypes: true });
      const assetFolders = subEntries.filter(e => e.isDirectory()).map(e => e.name);

      let itemsCount = 0;
      for (const assetFolder of assetFolders) {
        // Create an item if it doesn't exist
        const existingItem = await prisma.batchImportItem.findFirst({
          where: { batchId: batch.id, folderName: assetFolder }
        });

        if (!existingItem) {
          // Calculate size
          const assetPath = path.join(batchPath, assetFolder);
          let pesoMB = 0;
          try {
             let totalBytes = 0;
             const traverse = (dir) => {
               const files = fs.readdirSync(dir);
               for (const f of files) {
                 const p = path.join(dir, f);
                 const st = fs.statSync(p);
                 if (st.isDirectory()) traverse(p);
                 else totalBytes += st.size;
               }
             };
             traverse(assetPath);
             pesoMB = Number((totalBytes / (1024 * 1024)).toFixed(2));
          } catch(e) {}

          // Detectar imágenes
          const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
          let images = [];
          try {
            const findImages = (dir) => {
              for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isFile() && IMAGE_EXTS.includes(path.extname(e.name).toLowerCase())) {
                  images.push(path.relative(UPLOADS_DIR, p).replace(/\\/g, '/'));
                } else if (e.isDirectory()) findImages(p);
              }
            };
            findImages(assetPath);
          } catch {}

          await prisma.batchImportItem.create({
            data: {
              batchId: batch.id,
              folderName: assetFolder,
              title: assetFolder.replace(/_/g, ' '),
              pesoMB,
              images: images.length > 0 ? images : [],
              status: 'PENDING',
              mainStatus: 'PENDING',
              backupStatus: 'PENDING',
              mainProgress: 0
            }
          });
          newlyQueuedCount++;
        }
        itemsCount++;
      }

      await prisma.batchImport.update({
        where: { id: batch.id },
        data: { totalItems: itemsCount }
      });
    }

    return res.json({
      success: true,
      message: `Scanned and queued ${newlyQueuedCount} new items across batches.`,
      newlyQueuedCount
    });

  } catch (error) {
    console.error('[BATCH IMPORT SCAN ERROR]', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

// GET /api/batch-imports
export const getBatchQueue = async (req, res) => {
  try {
    const queue = await prisma.batchImportItem.findMany({
      include: {
        batch: true
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });
    return res.json({ success: true, items: queue });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/batch-imports/items/:id  — Actualizar campos de un item
export const updateBatchItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { targetAccount, title, tags, categories, similarityApproved } = req.body;

    const data = {};
    if (targetAccount !== undefined) data.targetAccount = Number(targetAccount) || null;
    if (title !== undefined) data.title = title;
    if (tags !== undefined) data.tags = tags;
    if (categories !== undefined) data.categories = categories;
    if (similarityApproved !== undefined) data.similarityApproved = !!similarityApproved;

    const updated = await prisma.batchImportItem.update({
      where: { id: Number(id) },
      data
    });

    return res.json({ success: true, item: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/batch-imports/confirm  — Confirmar items para Worker
export const confirmBatchItems = async (req, res) => {
  try {
    const { itemIds } = req.body;
    if (!Array.isArray(itemIds) || !itemIds.length) {
      return res.status(400).json({ success: false, message: 'itemIds requerido' });
    }

    const items = await prisma.batchImportItem.findMany({
      where: { id: { in: itemIds.map(Number) } }
    });

    let confirmed = 0;
    for (const item of items) {
      if (!item.targetAccount) continue;
      await prisma.batchImportItem.update({
        where: { id: item.id },
        data: { status: 'PENDING', error: null, mainStatus: 'PENDING', backupStatus: 'PENDING', mainProgress: 0 }
      });
      confirmed++;
    }

    return res.json({ success: true, confirmed });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/batch-imports/items/:id  — Borrar item + carpeta del disco
export const deleteBatchItem = async (req, res) => {
  try {
    const { id } = req.params;
    const item = await prisma.batchImportItem.findUnique({
      where: { id: Number(id) },
      include: { batch: true }
    });

    if (!item) return res.status(404).json({ success: false, message: 'Item no encontrado' });

    // Borrar carpeta del disco
    const folderPath = path.join(BATCH_DIR, item.batch.folderName, item.folderName);
    try {
      if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`[BATCH DELETE] Carpeta borrada: ${folderPath}`);
      }
    } catch (e) {
      console.warn(`[BATCH DELETE] Warn al borrar carpeta: ${e.message}`);
    }

    // Borrar de BD
    await prisma.batchImportItem.delete({ where: { id: Number(id) } });

    // Actualizar totalItems del batch padre
    const remaining = await prisma.batchImportItem.count({ where: { batchId: item.batchId } });
    await prisma.batchImport.update({
      where: { id: item.batchId },
      data: { totalItems: remaining }
    });

    return res.json({ success: true, message: 'Item eliminado y carpeta borrada' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

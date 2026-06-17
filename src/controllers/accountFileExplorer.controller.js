import { PrismaClient } from '@prisma/client';
import { megaLoginFull, megaLogoutSafe } from '../utils/megaSession.js';
import { decryptToJson } from '../utils/cryptoUtils.js';
import { runCmd } from '../utils/megaCmd.js';
import { withMegaLock } from '../utils/megaQueue.js';
import path from 'path';

const prisma = new PrismaClient();

const getAccountAndDecryptPayload = async (accountId) => {
  const acc = await prisma.megaAccount.findUnique({
    where: { id: Number(accountId) },
    include: { credentials: true },
  });
  if (!acc) throw new Error('Account not found');
  if (!acc.credentials) throw new Error('No credentials stored for this account');
  const payload = decryptToJson(acc.credentials.encData, acc.credentials.encIv, acc.credentials.encTag);
  return { account: acc, payload };
};

export const listAccountDirectory = async (req, res) => {
  const accountId = Number(req.params.id);
  let folderPath = req.query.path || '/';
  
  try {
    const { account, payload } = await getAccountAndDecryptPayload(accountId);
    
    if (!folderPath.startsWith('/')) {
      folderPath = '/' + folderPath;
    }
    
    let files = [];
    await withMegaLock(async () => {
      const ctx = `acc-explorer-list id=${accountId} path=${folderPath}`;
      await megaLoginFull(prisma, account.id, payload, ctx, { skipStorageRefresh: true });
      
      try {
        const lsResult = await runCmd('mega-ls', ['-l', folderPath], { timeoutMs: 30000 });
        const lines = (lsResult.out || '').split(/\r?\n/).filter(Boolean);
        
        for (const line of lines) {
          if (line.trim().startsWith('FLAGS') && line.includes('NAME')) continue;
          if (line.length < 5) continue;
          
          const flags = line.substring(0, 4);
          const rest = line.substring(4).trim();
          
          const match = rest.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
          if (!match) continue;
          
          const version = match[1];
          const sizeStr = match[2];
          const datePart = match[3];
          const timePart = match[4];
          const name = match[5].trim();
          
          const isDir = flags.startsWith('d');
          const size = sizeStr === '-' ? 0 : parseInt(sizeStr, 10);
          const modDate = `${datePart} ${timePart}`;
          
          const fileId = path.posix.join(folderPath, name);
          
          files.push({
            id: fileId,
            name,
            isDir,
            size,
            modDate,
          });
        }
      } catch (e) {
        if (e.message.includes('not found') || e.message.includes('No such file')) {
          // Empty or non-existent folder
        } else {
          throw e;
        }
      }
      
      await megaLogoutSafe(ctx);
    }, `ACC-EXPLORER-LIST-${accountId}`);
    
    files.sort((a, b) => {
      if (a.isDir === b.isDir) return a.name.localeCompare(b.name);
      return a.isDir ? -1 : 1;
    });
    
    return res.json({ success: true, files });
  } catch (error) {
    console.error(`[AccountExplorer] Error listAccountDirectory accId=${accountId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createAccountFolder = async (req, res) => {
  const accountId = Number(req.params.id);
  const { currentPath, folderName } = req.body;
  
  try {
    if (!folderName) {
      return res.status(400).json({ success: false, message: 'Nombre de carpeta requerido' });
    }
    
    const { account, payload } = await getAccountAndDecryptPayload(accountId);
    const targetPath = path.posix.join(currentPath || '/', folderName);
    
    await withMegaLock(async () => {
      const ctx = `acc-explorer-mkdir id=${accountId}`;
      await megaLoginFull(prisma, account.id, payload, ctx, { skipStorageRefresh: true });
      await runCmd('mega-mkdir', ['-p', targetPath], { timeoutMs: 20000 });
      await megaLogoutSafe(ctx);
    }, `ACC-EXPLORER-MKDIR-${accountId}`);
    
    return res.json({ success: true, message: 'Carpeta creada' });
  } catch (error) {
    console.error(`[AccountExplorer] Error createAccountFolder accId=${accountId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteAccountFiles = async (req, res) => {
  const accountId = Number(req.params.id);
  const { files } = req.body;
  
  try {
    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ success: false, message: 'Se requiere un array de archivos/carpetas' });
    }
    
    const { account, payload } = await getAccountAndDecryptPayload(accountId);
    const errors = [];
    
    await withMegaLock(async () => {
      const ctx = `acc-explorer-delete id=${accountId}`;
      await megaLoginFull(prisma, account.id, payload, ctx, { skipStorageRefresh: true });
      
      for (const fileId of files) {
        try {
          await runCmd('mega-rm', ['-rf', fileId], { timeoutMs: 30000 });
        } catch (e) {
          errors.push(`${fileId}: ${e.message}`);
        }
      }
      
      await megaLogoutSafe(ctx);
    }, `ACC-EXPLORER-DELETE-${accountId}`);
    
    if (errors.length) {
      return res.status(207).json({ success: false, message: `Errores: ${errors.join('; ')}` });
    }
    
    return res.json({ success: true, message: 'Elementos eliminados' });
  } catch (error) {
    console.error(`[AccountExplorer] Error deleteAccountFiles accId=${accountId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const purgeAccountFolder = async (req, res) => {
  const accountId = Number(req.params.id);
  const { folder } = req.body;
  
  try {
    if (!folder) {
      return res.status(400).json({ success: false, message: 'Se requiere la ruta de la carpeta' });
    }
    
    const { account, payload } = await getAccountAndDecryptPayload(accountId);
    
    await withMegaLock(async () => {
      const ctx = `acc-explorer-purge id=${accountId}`;
      await megaLoginFull(prisma, account.id, payload, ctx, { skipStorageRefresh: true });
      
      await runCmd('mega-rm', ['-rf', folder], { timeoutMs: 30000 });
      await runCmd('mega-mkdir', ['-p', folder], { timeoutMs: 20000 });
      
      await megaLogoutSafe(ctx);
    }, `ACC-EXPLORER-PURGE-${accountId}`);
    
    return res.json({ success: true, message: 'Carpeta purgada' });
  } catch (error) {
    console.error(`[AccountExplorer] Error purgeAccountFolder accId=${accountId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const renameAccountFile = async (req, res) => {
  const accountId = Number(req.params.id);
  const { file, newName } = req.body;
  
  try {
    if (!file || !newName) {
      return res.status(400).json({ success: false, message: 'Parámetros file y newName requeridos' });
    }
    
    const { account, payload } = await getAccountAndDecryptPayload(accountId);
    const parentDir = path.posix.dirname(file);
    const targetPath = path.posix.join(parentDir, newName);
    
    await withMegaLock(async () => {
      const ctx = `acc-explorer-rename id=${accountId}`;
      await megaLoginFull(prisma, account.id, payload, ctx, { skipStorageRefresh: true });
      await runCmd('mega-mv', [file, targetPath], { timeoutMs: 20000 });
      await megaLogoutSafe(ctx);
    }, `ACC-EXPLORER-RENAME-${accountId}`);
    
    return res.json({ success: true, message: 'Elemento renombrado' });
  } catch (error) {
    console.error(`[AccountExplorer] Error renameAccountFile accId=${accountId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const moveAccountFiles = async (req, res) => {
  const accountId = Number(req.params.id);
  const { files, destination } = req.body;
  
  try {
    if (!Array.isArray(files) || !files.length || !destination) {
      return res.status(400).json({ success: false, message: 'Parámetros files y destination requeridos' });
    }
    
    const { account, payload } = await getAccountAndDecryptPayload(accountId);
    
    await withMegaLock(async () => {
      const ctx = `acc-explorer-move id=${accountId}`;
      await megaLoginFull(prisma, account.id, payload, ctx, { skipStorageRefresh: true });
      
      for (const fileId of files) {
        await runCmd('mega-mv', [fileId, destination], { timeoutMs: 30000 });
      }
      
      await megaLogoutSafe(ctx);
    }, `ACC-EXPLORER-MOVE-${accountId}`);
    
    return res.json({ success: true, message: 'Elementos movidos' });
  } catch (error) {
    console.error(`[AccountExplorer] Error moveAccountFiles accId=${accountId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

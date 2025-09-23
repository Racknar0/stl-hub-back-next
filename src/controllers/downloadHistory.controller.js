import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Listar historial de descargas del usuario autenticado (máx 20)
export const listUserDownloads = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const items = await prisma.downloadHistory.findMany({
      where: { userId },
      orderBy: { downloadedAt: 'desc' },
      take: 20,
    });
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ message: 'Error listing downloads' });
  }
};

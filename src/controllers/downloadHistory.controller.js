import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Listar historial de descargas del usuario autenticado (paginado)
export const listUserDownloads = async (req, res) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100);

    const [total, items] = await prisma.$transaction([
      prisma.downloadHistory.count({ where: { userId } }),
      prisma.downloadHistory.findMany({
        where: { userId },
        orderBy: { downloadedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return res.json({ data: items, total, page, pageSize });
  } catch (e) {
    return res.status(500).json({ message: 'Error listing downloads' });
  }
};

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../utils/bcryptUtils.js';

const prisma = new PrismaClient();

// Create a new user (minimal: email, password, roleId)
export const createUser = async (req, res) => {
  const { email, password, roleId = 1, isActive = true } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    // Verificar que el email no esté registrado
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Email already in use' });

    const passwordHashed = await hashPassword(password);

    const newUser = await prisma.user.create({
      data: {
        email,
        password: passwordHashed,
        roleId,
        isActive,
      },
      select: { id: true, email: true, isActive: true, createdAt: true, roleId: true },
    });

    return res.status(201).json(newUser);
  } catch (error) {
    console.error('Error creating user:', error);
    return res.status(500).json({ message: 'Error creating user' });
  }
};

// Get all users (omit password) con paginación, búsqueda e info de suscripción activa
export const getUsers = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 10, 1), 1000);
    const q = (req.query.q || '').trim();

    const where = q ? { email: { contains: q } } : {};
    const today = new Date().toISOString().split('T')[0];

    const [total, users, downloadCounts] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          roleId: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          registerIp: true,
          registerCountry: true,
          lastLoginIp: true,
          lastLoginCountry: true,
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { id: true, status: true, startedAt: true, currentPeriodEnd: true },
          },
          dailyRolls: {
            where: { date: today },
            take: 1,
            select: { rollsUsed: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      // Conteo de descargas por usuario dentro de la página actual
      prisma.downloadHistory.groupBy({
        by: ['userId'],
        _count: { _all: true },
        where: { userId: { in: [] } }
      }),
    ]);

    // Si la agrupación falló (array vacío) porque no pudimos pasar ids dinámicamente, hacemos fallback fuera de la transacción
    let downloadMap = new Map();
    if (!downloadCounts || !downloadCounts.length) {
      const ids = users.map(u => u.id);
      if (ids.length) {
        const rows = await prisma.downloadHistory.groupBy({ by: ['userId'], _count: { _all: true }, where: { userId: { in: ids } } });
        downloadMap = new Map(rows.map(r => [r.userId, r._count._all]));
      }
    } else {
      downloadMap = new Map(downloadCounts.map(r => [r.userId, r._count._all]));
    }

    // Obtener configuración del límite de tiradas global
    const config = await prisma.systemSetting.findUnique({
      where: { key: 'FREEBIES_ROLLS_COUNT' }
    });
    const maxRolls = config && config.value ? (parseInt(config.value, 10) || 3) : 3;

    const enriched = users.map(u => ({
      ...u,
      downloadCount: downloadMap.get(u.id) || 0,
      rollsUsed: u.dailyRolls?.[0]?.rollsUsed ?? 0,
    }));

    res.status(200).json({ data: enriched, total, page, pageSize, maxRolls });
  } catch (error) {
    console.log('Error getting users: ', error);
    res.status(500).json({ message: 'Error getting users' });
  }
};

// Get user by id — enriched for admin user detail modal
export const getUserById = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: {
        id: true,
        email: true,
        isActive: true,
        language: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
        roleId: true,
        registerIp: true,
        registerCountry: true,
        lastLoginIp: true,
        lastLoginCountry: true,
        // Attribution
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmContent: true,
        utmTerm: true,
        utmLandingUrl: true,
        utmReferrer: true,
        // Subscription
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true, status: true, startedAt: true, currentPeriodEnd: true },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Compute subscription info
    const sub = user.subscriptions?.[0] || null;
    const now = new Date();
    const subEnd = sub ? new Date(sub.currentPeriodEnd) : null;
    const daysRemaining = subEnd ? Math.max(0, Math.ceil((subEnd - now) / (1000 * 60 * 60 * 24))) : 0;

    // Download history (paginated)
    const dlPage = Math.max(parseInt(req.query.dlPage) || 1, 1);
    const dlPageSize = Math.min(Math.max(parseInt(req.query.dlPageSize) || 20, 1), 100);
    const downloads = await prisma.downloadHistory.findMany({
      where: { userId: user.id },
      orderBy: { downloadedAt: 'desc' },
      skip: (dlPage - 1) * dlPageSize,
      take: dlPageSize,
    });

    // Enrich downloads with asset images
    const assetIds = [...new Set(downloads.map((d) => d.assetId).filter(Boolean))];
    const assets = assetIds.length
      ? await prisma.asset.findMany({
          where: { id: { in: assetIds } },
          select: { id: true, title: true, slug: true, images: true },
        })
      : [];
    const assetMap = new Map(assets.map((a) => [a.id, a]));
    const enrichedDownloads = downloads.map((d) => {
      const asset = assetMap.get(d.assetId);
      const images = Array.isArray(asset?.images) ? asset.images : [];
      return {
        assetId: d.assetId,
        title: d.assetTitle || asset?.title || `#${d.assetId}`,
        slug: asset?.slug || null,
        image: images[0] || null,
        downloadedAt: d.downloadedAt,
      };
    });

    // Download count total
    const totalDownloads = await prisma.downloadHistory.count({ where: { userId: user.id } });

    // Top categories from downloads
    const topCatsRaw = assetIds.length
      ? await prisma.category.findMany({
          where: { assets: { some: { id: { in: assetIds } } } },
          select: { id: true, name: true, _count: { select: { assets: true } } },
          orderBy: { name: 'asc' },
          take: 10,
        })
      : [];
    const topCategories = topCatsRaw.map((c) => ({
      id: c.id,
      name: c.name,
      count: c._count?.assets || 0,
    }));

    // Build response
    const { subscriptions, ...userData } = user;
    return res.status(200).json({
      ...userData,
      subscription: sub
        ? { status: sub.status, startedAt: sub.startedAt, currentPeriodEnd: sub.currentPeriodEnd, daysRemaining }
        : null,
      stats: { totalDownloads, topCategories },
      downloads: enrichedDownloads,
      dlPage,
      dlPageSize,
      dlTotal: totalDownloads,
    });
  } catch (error) {
    console.log('Error getting user: ', error);
    res.status(500).json({ message: 'Error getting user' });
  }
};

// Update user (email, password, isActive, roleId)
export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { email, password, isActive, roleId } = req.body;

  try {
    const dataToUpdate = { };
    if (email !== undefined) dataToUpdate.email = email;
    if (isActive !== undefined) dataToUpdate.isActive = isActive;
    if (roleId !== undefined) dataToUpdate.roleId = roleId;

    if (password) {
      dataToUpdate.password = await hashPassword(password);
    }

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(id) },
      data: dataToUpdate,
      select: { id: true, email: true, isActive: true, createdAt: true, updatedAt: true, roleId: true },
    });

    return res.status(200).json(updatedUser);
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(500).json({ message: 'Error updating user' });
  }
};

// Delete user
export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: { id: true, email: true, isActive: true, roleId: true },
    });

    if (!user) return res.status(404).json({ message: 'User not found' });

    // No permitir borrar administradores por seguridad
    if (user.roleId === 2) {
      return res.status(403).json({ message: 'Admins cannot be deleted' });
    }

    await prisma.$transaction([
      prisma.subscription.deleteMany({ where: { userId: user.id } }),
      prisma.user.delete({ where: { id: user.id } }),
    ]);

    return res.status(200).json(user);
  } catch (error) {
    console.log('Error deleting user: ', error);
    if (error?.code === 'P2003') {
      return res.status(409).json({ message: 'Cannot delete user due to related records' });
    }
    return res.status(500).json({ message: 'Error deleting user' });
  }
};

// Extender suscripción activa del usuario: por días (preferido) o por meses (3, 6, 12)
export const extendSubscription = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { months, daysToAdd, daysRemaining } = req.body; // Prefer daysRemaining

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();
    const addMonths = (date, m) => { const d = new Date(date); d.setMonth(d.getMonth() + m); return d; };
    const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };

    // Última suscripción (activa o expirada)
    const latestSub = await prisma.subscription.findFirst({
      where: { userId },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    let newEnd;
    let status = 'ACTIVE';

    if (daysRemaining !== undefined) {
      const days = Number(daysRemaining);
      if (!Number.isInteger(days) || days < 0) {
        return res.status(400).json({ message: 'daysRemaining must be a positive integer or 0' });
      }
      const safeDays = Math.min(days, 3650); // Máx ~10 años
      newEnd = addDays(now, safeDays);
      if (safeDays === 0) {
        status = 'EXPIRED';
      }
    } else if (daysToAdd !== undefined) {
      const days = Number(daysToAdd);
      if (Number.isFinite(days) && days > 0) {
        const base = (latestSub && latestSub.currentPeriodEnd > now) ? latestSub.currentPeriodEnd : now;
        const safeDays = Math.min(days, 3650); // Máx ~10 años
        newEnd = addDays(base, safeDays);
      } else {
        return res.status(400).json({ message: 'Provide a valid daysToAdd (>0).' });
      }
    } else {
      // Fallback a meses (compatibilidad)
      const m = Number(months);
      if (![3, 6, 12].includes(m)) {
        return res.status(400).json({ message: 'Provide daysRemaining, daysToAdd (>0) or valid months (3, 6 or 12).' });
      }
      const base = (latestSub && latestSub.currentPeriodEnd > now) ? latestSub.currentPeriodEnd : now;
      newEnd = addMonths(base, m);
    }

    // Si daysRemaining es 0 y no hay suscripción activa, no hace falta hacer nada
    if (daysRemaining !== undefined && Number(daysRemaining) === 0 && !latestSub) {
      return res.status(200).json({ message: 'Subscription already inactive/expired' });
    }

    let updatedSub;
    if (latestSub) {
      updatedSub = await prisma.subscription.update({
        where: { id: latestSub.id },
        data: { currentPeriodEnd: newEnd, startedAt: latestSub.startedAt ?? now, status: status },
      });
    } else {
      updatedSub = await prisma.subscription.create({
        data: { userId, status: status, startedAt: now, currentPeriodEnd: newEnd },
      });
    }

    return res.status(200).json({ message: 'Subscription updated', subscription: updatedSub });
  } catch (error) {
    console.error('Error extending subscription:', error);
    return res.status(500).json({ message: 'Error extending subscription' });
  }
};

// Reiniciar tiradas de freebies del día de hoy para un usuario específico (admin ops)
export const resetUserFreebieRolls = async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) return res.status(400).json({ message: 'Invalid User ID' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const today = new Date().toISOString().split('T')[0];

    // Eliminar el registro del día de hoy para este usuario
    await prisma.userDailyRolls.deleteMany({
      where: {
        userId,
        date: today,
      },
    });

    return res.status(200).json({ message: 'Daily rolls reset successfully' });
  } catch (error) {
    console.error('Error resetting user freebie rolls:', error);
    return res.status(500).json({ message: 'Error resetting freebie rolls' });
  }
};

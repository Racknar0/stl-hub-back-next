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
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 10, 1), 100);
    const q = (req.query.q || '').trim();

    const where = q ? { email: { contains: q } } : {};

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
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: { id: true, status: true, startedAt: true, currentPeriodEnd: true },
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
        where: { userId: { in: await (async ()=>{
          // Extraer ids de la página actual
          // (Se hace en línea porque no podemos referenciar users todavía fuera del txn)
          // Este truco se ignora, replaceremos luego manualmente si no funciona.
          return []
        })() } }
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

    const enriched = users.map(u => ({ ...u, downloadCount: downloadMap.get(u.id) || 0 }));

    res.status(200).json({ data: enriched, total, page, pageSize });
  } catch (error) {
    console.log('Error getting users: ', error);
    res.status(500).json({ message: 'Error getting users' });
  }
};

// Get user by id (omit password)
export const getUserById = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(id) },
      select: { id: true, email: true, isActive: true, createdAt: true, updatedAt: true, roleId: true },
    });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json(user);
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
    const { months, daysToAdd } = req.body; // Prefer daysToAdd

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();
    const addMonths = (date, m) => { const d = new Date(date); d.setMonth(d.getMonth() + m); return d; };
    const addDays = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d; };

    // Última suscripción activa
    const activeSub = await prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
    });

    let newEnd;
    const days = Number(daysToAdd);
    if (Number.isFinite(days) && days > 0) {
      const base = (activeSub && activeSub.currentPeriodEnd > now) ? activeSub.currentPeriodEnd : now;
      const safeDays = Math.min(days, 3650); // Máx ~10 años
      newEnd = addDays(base, safeDays);
    } else {
      // Fallback a meses (compatibilidad)
      const m = Number(months);
      if (![3, 6, 12].includes(m)) {
        return res.status(400).json({ message: 'Provide daysToAdd (>0) or valid months (3, 6 or 12).' });
      }
      const base = (activeSub && activeSub.currentPeriodEnd > now) ? activeSub.currentPeriodEnd : now;
      newEnd = addMonths(base, m);
    }

    let updatedSub;
    if (activeSub) {
      updatedSub = await prisma.subscription.update({
        where: { id: activeSub.id },
        data: { currentPeriodEnd: newEnd, startedAt: activeSub.startedAt ?? now, status: 'ACTIVE' },
      });
    } else {
      updatedSub = await prisma.subscription.create({
        data: { userId, status: 'ACTIVE', startedAt: now, currentPeriodEnd: newEnd },
      });
    }

    return res.status(200).json({ message: 'Subscription extended', subscription: updatedSub });
  } catch (error) {
    console.error('Error extending subscription:', error);
    return res.status(500).json({ message: 'Error extending subscription' });
  }
};

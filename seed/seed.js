import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Crear los roles base
  await prisma.role.createMany({
    data: [
      { name: 'User' },
      { name: 'Admin' },
      { name: 'Moderator' },
    ],
    skipDuplicates: true,
  });
  console.log('Roles verificados');

  const userRole = await prisma.role.findFirst({ where: { name: 'User' } });
  if (!userRole) throw new Error('No existe el rol User');

  const defaultPassword = 'Password123!';
  const passwordHashed = await bcrypt.hash(defaultPassword, 10);

  const addMonths = (date, months) => { const d = new Date(date); d.setMonth(d.getMonth() + months); return d; };
  const addYears  = (date, years)  => { const d = new Date(date); d.setFullYear(d.getFullYear() + years); return d; };

  const total = 100;
  const threeCount = 34; // 34 con 3 meses
  const sixCount = 33;   // 33 con 6 meses
  const yearCount = 33;  // 33 con 1 año

  let created = 0, skipped = 0;

  const createOne = async (i, plan) => {
    const email = `seeduser${String(i).padStart(3, '0')}@example.com`;
    const now = new Date();
    const expiration = plan === '3m' ? addMonths(now, 3) : plan === '6m' ? addMonths(now, 6) : addYears(now, 1);

    try {
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            password: passwordHashed,
            roleId: userRole.id,
            isActive: true,
          },
        });
        await tx.subscription.create({
          data: {
            userId: user.id,
            status: 'ACTIVE',
            startedAt: now,
            currentPeriodEnd: expiration,
          },
        });
      });
      created += 1;
    } catch (e) {
      if (e.code === 'P2002') { // unique constraint
        skipped += 1;
      } else {
        console.error(`Error creando ${email}:`, e);
      }
    }
  };

  // 1..100
  let idx = 1;
  for (; idx <= threeCount; idx++) await createOne(idx, '3m');
  for (; idx <= threeCount + sixCount; idx++) await createOne(idx, '6m');
  for (; idx <= total; idx++) await createOne(idx, '1y');

  console.log(`Usuarios creados: ${created}, omitidos (email ya existente): ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

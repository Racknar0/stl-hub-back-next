import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Crear los roles
  await prisma.role.createMany({
    data: [
      { name: 'User' },
      { name: 'Admin' },
      { name: 'Moderator' },
    ],
    skipDuplicates: true, // Evita errores si ya existen
  });

  console.log('Roles creados con éxito');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const freebiesCount = await prisma.asset.count({
    where: { isPremium: false, status: 'PUBLISHED' }
  });
  console.log("=== FREEBIES DIARIOS ===");
  console.log("Cantidad total de freebies (isPremium=false):", freebiesCount);

  const sample = await prisma.asset.findMany({
    where: { isPremium: false, status: 'PUBLISHED' },
    take: 5,
    select: { id: true, title: true, isPremium: true }
  });
  console.log("Muestra de 5 freebies:", sample);
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());

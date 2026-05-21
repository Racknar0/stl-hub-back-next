import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const settings = [
    {
      key: 'LIMIT_FREE_PASS_FREE_DOWNLOADS',
      value: '100',
      description: 'Límite diario de descargas para usuarios registrados gratuitos cuando el Free Pass está activo.',
    },
    {
      key: 'LIMIT_NORMAL_FREE_DOWNLOADS',
      value: '50',
      description: 'Límite diario de descargas de archivos gratuitos para usuarios registrados gratuitos cuando el Free Pass está inactivo.',
    },
    {
      key: 'LIMIT_SUBSCRIBED_DOWNLOADS',
      value: '500',
      description: 'Límite diario de descargas para usuarios con suscripción activa.',
    },
  ];

  console.log('Iniciando inserción de configuraciones de límites...');
  
  for (const s of settings) {
    const existing = await prisma.systemSetting.findUnique({
      where: { key: s.key },
    });

    if (!existing) {
      await prisma.systemSetting.create({
        data: s,
      });
      console.log(`Creada configuración: ${s.key} = ${s.value}`);
    } else {
      console.log(`La configuración ya existe: ${s.key}`);
    }
  }

  console.log('Proceso de seeding finalizado.');
}

main()
  .catch((e) => {
    console.error('Error al ejecutar seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

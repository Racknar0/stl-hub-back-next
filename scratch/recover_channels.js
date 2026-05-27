import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function recover() {
  console.log('--- DETECTANDO TOP CANALES Y FILENAMES ---');
  
  const matchesByChannel = new Map();
  
  // 1. Analizar Assets de la base de datos (archiveName e imágenes)
  const assets = await prisma.asset.findMany({
    select: {
      id: true,
      title: true,
      archiveName: true,
      images: true,
    }
  });
  
  for (const asset of assets) {
    if (asset.archiveName) {
      const parts = asset.archiveName.split('/');
      const fileName = parts[parts.length - 1];
      const match = fileName.match(/^([a-zA-Z0-9]+)_(\d+)_/);
      if (match) {
        const channel = match[1];
        if (!matchesByChannel.has(channel)) {
          matchesByChannel.set(channel, { count: 0, samples: new Set() });
        }
        const entry = matchesByChannel.get(channel);
        entry.count++;
        if (entry.samples.size < 3) {
          entry.samples.add(fileName);
        }
      }
    }
  }

  console.log('\n--- TOP 15 CANALES DETECTADOS ---');
  const sorted = Array.from(matchesByChannel.entries()).sort((a, b) => b[1].count - a[1].count);
  
  for (const [chan, data] of sorted.slice(0, 15)) {
    console.log(` Canal: "${chan}" | Ocurrencias en DB: ${data.count}`);
    console.log(`   Ejemplos de archivos:`);
    for (const s of data.samples) {
      console.log(`     - ${s}`);
    }
    console.log('----------------------------------------------------');
  }
}

recover()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

// Usage: node --env-file=.env scripts/importHeroBanners.js /absolute/path/manifest.json
// Every variant requires all four paths. Stable seedKey values make repeat imports non-destructive.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createHeroBannersService, HERO_SLOTS } from '../src/services/heroBanners.service.js';

const manifestFile = process.argv[2];
if (!manifestFile) { console.error('Uso: node --env-file=.env scripts/importHeroBanners.js manifest.json'); process.exit(1); }
const prisma = new PrismaClient();
try {
  const absolute = path.resolve(manifestFile);
  const manifest = JSON.parse(await fs.readFile(absolute, 'utf8'));
  const variants = Array.isArray(manifest) ? manifest : manifest.variants;
  if (!Array.isArray(variants) || !variants.length) throw new Error('El manifiesto necesita un array de variantes.');
  const service = createHeroBannersService({ prisma });
  let created = 0, reused = 0;
  for (const input of variants) {
    if (typeof input.seedKey !== 'string' || !input.seedKey.trim()) throw new Error('Cada variante importada necesita seedKey estable.');
    const files = Object.fromEntries(HERO_SLOTS.map(slot => {
      const value = input[slot] || input.images?.[slot]?.path;
      if (typeof value !== 'string') throw new Error(`${input.seedKey}: falta la ruta ${slot}.`);
      return [slot, { path: path.resolve(path.dirname(absolute), value) }];
    }));
    const result = await service.create(input, files, { seedKey: input.seedKey });
    if (result.reused) reused++; else created++;
    console.log(JSON.stringify({ seedKey: input.seedKey, id: result.variant.id, reused: result.reused, images: result.variant.images }));
  }
  console.log(JSON.stringify({ created, reused, total: variants.length }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await prisma.$disconnect(); }

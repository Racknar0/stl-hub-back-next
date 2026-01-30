import { pathToFileURL } from 'url';
import { randomizeFreebies, getRandomizeFreebiesCountFromEnv } from './randomizeFreebies.js';

function parseArgCount(argv) {
  const a = argv.find((x) => x.startsWith('--count='));
  if (!a) return null;
  const raw = a.split('=')[1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

async function main() {
  const argCount = parseArgCount(process.argv.slice(2));
  const envCount = getRandomizeFreebiesCountFromEnv(process.env);
  const count = argCount != null ? argCount : envCount;

  const result = await randomizeFreebies({ count });
  // Log simple para cron
  console.log(
    `[FREEBIES] total=${result.total} selected=${result.selected} count=${result.count}`
  );
}

// Ejecutar solo si este archivo es el entrypoint (evita ejecutar si alguien lo importa)
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((e) => {
    console.error('[FREEBIES] error', e);
    process.exit(1);
  });
}

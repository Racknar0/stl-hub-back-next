/**
 * SCRIPT: repairBrokenSlugs.js
 *
 * Detecta y repara slugs donde se truncaron vocales acentuadas españolas.
 * - "corazón" → bad: "coraz-n"  / good: "corazon"
 * - "capitán" → bad: "capit-n"  / good: "capitan"
 * - "vehículo" → bad: "veh-culo" / good: "vehiculo"
 * - "autobús" → bad: "autob-s"  / good: "autobus"
 * - "expresión" → bad: "expresi-n" / good: "expresion"
 *
 * NO toca slugs como "pinky-y-cerebro", "dbz-cell", "dr-doom" (son válidos).
 *
 * EJECUTAR EN EL VPS:
 *   node repairBrokenSlugs.js
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ───────────────────────────────────────────────────────────────────
// Segmentos cortos LEGÍTIMOS que no son acentos rotos
// ───────────────────────────────────────────────────────────────────
const LEGIT_SEGMENTS = new Set([
  // Conjunciones y preposiciones españolas
  'y', 'e', 'o', 'a', 'u', 'de', 'del', 'la', 'el', 'en', 'con',
  'los', 'las', 'un', 'una', 'al', 'por', 'sin', 'su', 'sus',
  // Conjunciones / partículas inglesas
  'x', 'vs', 'by', 'of', 'in', 'an', 'at', 'the', 'and', 'for',
  // Abreviaturas comunes en nombres de figuras
  'dr', 'jr', 'mr', 'sr', 'st', 'mc', 'lc', 'mx', 'dj',
  // Siglas comunes en este catálogo
  'dbz', 'dbgt', 'jjk', 'aot', 'mha', 'lol', 'stl', 'rc',
  'mmm', 'sfw', 'nsfw', 'tmnt', 'xmen',
  // Otros tokens habituales en slugs
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix',
]);

/**
 * Detecta si un slug tiene un patrón de acento español truncado.
 *
 * REGLA PRINCIPAL:
 *  Un segmento de 3+ letras que TERMINA en consonante,
 *  seguido de un segmento de 1-2 letras que son SOLO consonantes
 *  y NO está en la lista de siglas legítimas.
 *
 *  Ejemplo: "coraz" (termina en z) + "n" → corazón roto ✓
 *           "capit" (termina en t) + "n" → capitán roto ✓
 *           "autob" (termina en b) + "s" → autobús roto ✓
 *           "expresi" (termina en i... espera eso tiene vocal)
 *
 * REGLA SECUNDARIA:
 *  Segmento de 2-4 chars sin vocales que rompe una palabra larga española.
 *  Ejemplo: "veh" + "culo" → vehículo, "ping" + "ino" → pingüino
 *  Detectado como: segmento de 2-4 chars, SIN vocales, entre segmentos normales.
 */
function hasBrokenAccentPattern(slug) {
  const parts = slug.split('-').filter(Boolean);

  for (let i = 0; i < parts.length - 1; i++) {
    const curr = parts[i];
    const next = parts[i + 1];

    if (LEGIT_SEGMENTS.has(curr) || LEGIT_SEGMENTS.has(next)) continue;
    if (/^\d+$/.test(curr) || /^\d+$/.test(next)) continue;

    // REGLA 1: segmentos de 1-2 chars solo-consonantes que NO son abreviaturas
    // El segmento actual debe terminar en consonante para que sea verosímil un acento truncado
    if (
      next.length >= 1 && next.length <= 2 &&
      /^[^aeiou]+$/.test(next) &&        // next es solo consonantes
      curr.length >= 3 &&                 // curr es una palabra real
      /[^aeiou]$/.test(curr)             // curr termina en consonante (acento estaba aquí)
    ) {
      return true;
    }

    // REGLA 2: segmento corto de 2-4 chars sin vocales entre dos palabras normales
    // (ej: "veh-culo" donde "veh" no tiene vowel at end y "culo" sí)
    if (
      curr.length >= 2 && curr.length <= 4 &&
      /^[^aeiou]+$/.test(curr) &&        // curr es solo consonantes (sin vocales)
      curr.length < 5 &&
      next.length >= 3 &&                 // next es suficientemente largo
      /[aeiou]/.test(next)               // next tiene vocales (es parte real de la palabra)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Repara el slug usando el título como fuente de verdad.
 * Solo modifica la MÍNIMA parte necesaria para arreglar el acento truncado.
 */
function repairSlug(brokenSlug, title) {
  if (!title) return null;

  // Generar slug limpio desde el título (con NFD normalizado)
  const fromTitle = String(title)
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);

  // El slug reparado ideal viene del título
  // Pero preservamos el prefijo actual del slug si es diferente al del título
  // (para no cambiar "pinky-y-cerebro" a "stl-pinky-y-cerebro")
  const brokenParts = brokenSlug.split('-').filter(Boolean);
  const titleParts = fromTitle.split('-').filter(Boolean);

  // Si el slug tiene un prefijo que el título no (ej: "stl---"), preservarlo
  // Reconstruir: reemplazar los segmentos rotos con los del título
  const repaired = brokenParts.map((part) => {
    if (LEGIT_SEGMENTS.has(part) || /[aeiou]/.test(part) || /^\d+$/.test(part)) return part;
    // Buscar coincidencia en titleParts que empiece por este segmento
    const match = titleParts.find((tp) => tp.startsWith(part) && tp.length > part.length);
    return match || part;
  }).join('-').replace(/-{2,}/g, '-');

  // Si la reparación parcial no mejoró nada, usar el slug del título completo
  if (repaired === brokenSlug) return fromTitle;
  return repaired;
}

async function main() {
  console.log('🔍 Buscando slugs con acentos españoles truncados...\n');

  const assets = await prisma.asset.findMany({
    select: { id: true, slug: true, title: true, titleEn: true },
    orderBy: { id: 'asc' },
  });

  console.log(`Total assets en BD: ${assets.length}`);

  const toFix = [];

  for (const asset of assets) {
    if (!hasBrokenAccentPattern(asset.slug)) continue;

    const newSlug = repairSlug(asset.slug, asset.title || asset.titleEn);
    if (!newSlug || newSlug === asset.slug) continue;

    toFix.push({ id: asset.id, oldSlug: asset.slug, newSlug, title: asset.title });
  }

  console.log(`\n📋 Assets con acento truncado genuino: ${toFix.length}\n`);

  if (toFix.length === 0) {
    console.log('✅ No se encontraron slugs rotos por acentos. ¡Todo limpio!');
    return;
  }

  const sample = toFix.slice(0, 50);
  console.log('MUESTRA (primeros 50):');
  for (const f of sample) {
    console.log(`  ID ${f.id}: "${f.oldSlug}" → "${f.newSlug}" (titulo: "${f.title?.slice(0, 60)}")`);
  }

  console.log(`\n⚠️  Total a reparar: ${toFix.length} slugs`);
  console.log('Para APLICAR: descomenta el bloque UPDATE abajo y re-ejecuta.\n');

  // ---------------------------------------------------------
  // DESCOMENTA PARA APLICAR (SOLO después de validar la muestra):
  // ---------------------------------------------------------
  // let fixed = 0, skipped = 0;
  // for (const f of toFix) {
  //   let candidate = f.newSlug;
  //   let suffix = 1;
  //   while (true) {
  //     const existing = await prisma.asset.findFirst({ where: { slug: candidate, NOT: { id: f.id } } });
  //     if (!existing) break;
  //     suffix++;
  //     candidate = `${f.newSlug}-${suffix}`;
  //   }
  //   try {
  //     await prisma.asset.update({ where: { id: f.id }, data: { slug: candidate } });
  //     console.log(`✅ ID ${f.id}: "${f.oldSlug}" → "${candidate}"`);
  //     fixed++;
  //   } catch (e) {
  //     console.error(`❌ ID ${f.id}: error → ${e.message}`);
  //     skipped++;
  //   }
  // }
  // console.log(`\n🎉 Completado: ${fixed} arreglados, ${skipped} errores.`);
  // ---------------------------------------------------------
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

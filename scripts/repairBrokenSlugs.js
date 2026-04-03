/**
 * SCRIPT: repairBrokenSlugs.js
 *
 * Repara UNICAMENTE slugs con caracteres rotos por acentos mal normalizados.
 * Ejemplos de slugs REALMENTE ROTOS: "coraz-n", "capit-n", "veh-culo", "autob-s"
 * (la vocal acentuada fue eliminada dejando solo la consonante)
 *
 * ⚠️  NO toca slugs que simplemente usen otra convención (ej: sin prefijo "stl-")
 *
 * EJECUTAR EN EL VPS:
 *   node repairBrokenSlugs.js
 *
 * REQUIERE: .env con DATABASE_URL configurado
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Detecta si un slug tiene un segmento genuinamente roto por acentos truncados.
 * Patron: segmento de solo consonantes seguido de otro segmento con consonante.
 * Ejemplos reales: "coraz-n", "veh-culo", "capit-n", "autob-s", "igl-"
 *
 * NO detecta como "rotos":
 *  - "pinky-y-cerebro" → slug válido sin prefijo stl-
 *  - "stl---joker"     → prefijo triple válido
 */
function hasBrokenAccentPattern(slug) {
    const parts = slug.split('-').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
        const current = parts[i];
        const next = parts[i + 1];
        // Segmento de 1-5 letras con SOLO consonantes (sin vocales a e i o u)
        // seguido de un segmento que también empieza con consonante → señal de vocal truncada
        if (
            current.length >= 1 &&
            current.length <= 5 &&
            /^[^aeiou0-9]+$/.test(current) &&
            next.length >= 1 &&
            /^[^aeiou]/.test(next)
        ) {
            return true;
        }
    }

    // También: segmento final de 1 sola consonante (slug termina en "-n", "-s", "-z")
    const last = parts[parts.length - 1];
    const prev = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (last && last.length === 1 && /^[^aeiou0-9]$/.test(last) && prev.length >= 2) {
        return true;
    }

    return false;
}

/**
 * Reconstruye el slug reparando los segmentos rotos usando el título como fuente.
 */
function repairSlug(brokenSlug, title) {
    if (!title) return null;

    // Generar slug limpio desde el título
    const fromTitle = String(title)
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 120);

    const brokenParts = brokenSlug.split('-').filter(Boolean);
    const goodParts = fromTitle.split('-').filter(Boolean);

    const repaired = brokenParts.map((part) => {
        // Segmento intacto (tiene vocal o dígito): no tocar
        if (/[aeiou]/.test(part) || /\d/.test(part) || part.length <= 2) return part;
        // Buscar segmento correspondiente en goodParts que empiece igual pero sea más largo
        const match = goodParts.find((gp) => gp.startsWith(part) && gp.length > part.length);
        return match || part;
    }).join('-').replace(/-{2,}/g, '-');

    return repaired !== brokenSlug ? repaired : fromTitle;
}

async function main() {
    console.log('🔍 Analizando slugs REALMENTE ROTOS (solo patrones de acentos truncados)...\n');

    const assets = await prisma.asset.findMany({
        select: { id: true, slug: true, title: true, titleEn: true },
        orderBy: { id: 'asc' },
    });

    console.log(`Total assets: ${assets.length}`);

    const toFix = [];

    for (const asset of assets) {
        if (!hasBrokenAccentPattern(asset.slug)) continue;

        const newSlug = repairSlug(asset.slug, asset.title || asset.titleEn);
        if (!newSlug || newSlug === asset.slug) continue;

        toFix.push({ id: asset.id, oldSlug: asset.slug, newSlug, title: asset.title });
    }

    console.log(`\n📋 Assets con slug genuinamente roto (acento truncado): ${toFix.length}\n`);

    if (toFix.length === 0) {
        console.log('✅ No se encontraron slugs rotos por acentos. ¡Todo limpio!');
        return;
    }

    const sample = toFix.slice(0, 40);
    console.log('MUESTRA (primeros 40):');
    for (const f of sample) {
        console.log(`  ID ${f.id}: "${f.oldSlug}" → "${f.newSlug}" (titulo: "${f.title?.slice(0, 50)}")`);
    }

    console.log('\n⚠️  Para APLICAR los cambios, descomenta el bloque UPDATE abajo y re-ejecuta.\n');

    // ---------------------------------------------------------
    // DESCOMENTA PARA APLICAR (después de revisar la muestra):
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

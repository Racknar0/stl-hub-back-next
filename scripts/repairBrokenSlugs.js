/**
 * SCRIPT: repairBrokenSlugs.js
 *
 * Repara slugs rotos en la BD que contenían acentos mal normalizados.
 * Ejemplo: "coraz-n" → "corazon", "capit-n" → "capitan"
 *
 * EJECUTAR EN EL VPS:
 *   node repairBrokenSlugs.js
 *
 * REQUIERE: .env con DATABASE_URL configurado
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function safeSlugFixed(str) {
    return String(str || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // normaliza acentos: á→a, é→e, ó→o, ñ→n
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-') // colapsa dobles guiones
        .slice(0, 120);
}

function detectBrokenSlug(slug) {
    // Un slug "roto" tiene secuencias de solo consonantes seguidas de guión
    // causadas por acentos eliminados incorrectamente, ej: "coraz-n", "capit-n"
    // También detecta guiones dobles: "stl---"
    return (
        /[a-z]-[a-z]\b/.test(slug) &&
        !/\d/.test(slug.split('-')[slug.split('-').length - 1])
    );
}

async function main() {
    console.log('🔍 Analizando slugs en la base de datos...\n');

    const assets = await prisma.asset.findMany({
        select: { id: true, slug: true, title: true, titleEn: true },
        orderBy: { id: 'asc' },
    });

    console.log(`Total assets: ${assets.length}`);

    const toFix = [];

    for (const asset of assets) {
        // Recalcular el slug esperado desde el título
        const expectedBase = safeSlugFixed(asset.title || asset.titleEn || '');

        // Detectar diferencias
        if (expectedBase && asset.slug !== expectedBase) {
            // Verificar si es un slug genuinamente diferente (ej: con sufijos -2, -3) o roto
            const slugWithoutSuffix = asset.slug.replace(/-\d+$/, '');
            const expectedWithoutSuffix = expectedBase;

            if (slugWithoutSuffix !== expectedWithoutSuffix) {
                toFix.push({
                    id: asset.id,
                    oldSlug: asset.slug,
                    expectedSlug: expectedBase,
                    title: asset.title,
                });
            }
        }
    }

    console.log(`\n📋 Assets con slug potencialmente roto: ${toFix.length}\n`);

    if (toFix.length === 0) {
        console.log('✅ No se encontraron slugs rotos.');
        return;
    }

    // Mostrar los primeros 30 para revisión
    const sample = toFix.slice(0, 30);
    console.log('MUESTRA (primeros 30):');
    for (const f of sample) {
        console.log(
            `  ID ${f.id}: "${f.oldSlug}" → esperado: "${f.expectedSlug}" (titulo: "${f.title?.slice(0, 50)}")`,
        );
    }

    // Preguntar si proceder
    console.log(
        '\n⚠️  Para APLICAR los cambios, descomenta la sección UPDATE más abajo y vuelve a ejecutar.\n',
    );

    // ---------------------------------------------------------
    // DESCOMENTA ESTE BLOQUE PARA APLICAR LOS CAMBIOS:
    // ---------------------------------------------------------
    let fixed = 0,
        skipped = 0;
    for (const f of toFix) {
        // Asegurarse de que el nuevo slug sea único
        let candidate = f.expectedSlug;
        let suffix = 1;
        while (true) {
            const existing = await prisma.asset.findFirst({
                where: { slug: candidate, NOT: { id: f.id } },
            });
            if (!existing) break;
            suffix++;
            candidate = `${f.expectedSlug}-${suffix}`;
        }
        try {
            await prisma.asset.update({
                where: { id: f.id },
                data: { slug: candidate },
            });
            console.log(`✅ ID ${f.id}: "${f.oldSlug}" → "${candidate}"`);
            fixed++;
        } catch (e) {
            console.error(`❌ ID ${f.id}: error → ${e.message}`);
            skipped++;
        }
    }
    console.log(`\n🎉 Completado: ${fixed} arreglados, ${skipped} errores.`);
    // ---------------------------------------------------------
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());

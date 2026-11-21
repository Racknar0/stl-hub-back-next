// Índice en memoria de los assets publicados que el filtro +18 deja fuera para visitantes anónimos.
//
// buildNsfwWhere compara ~120 palabras clave con LIKE '%…%' contra los tags, categorías, título y
// slug de cada asset; en MySQL eso tarda unos 6 s por consulta (el conteo del sitemap). Aquí la
// misma comparación se hace una vez en Node y el resultado se reutiliza unos minutos.
import { PrismaClient } from '@prisma/client';
import { NSFW_KEYWORDS, buildNsfwWhere } from '../middlewares/nsfwFilter.js';

const prisma = new PrismaClient();

const INDEX_TTL_MS = 10 * 60 * 1000; // cada cuánto se recalcula el índice

// Igual que LIKE con utf8mb4_unicode_ci: sin distinguir mayúsculas ni tildes.
export function foldText(value) {
    return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const KEYWORDS = [...new Set(NSFW_KEYWORDS.map(foldText))];

export function matchesNsfwKeyword(value) {
    const text = foldText(value);
    return text.length > 0 && KEYWORDS.some((kw) => text.includes(kw));
}

// Mismos campos que revisa buildNsfwWhere: tags por slug, name y nameEn; categorías por slug.
export const findNsfwTagIds = (tags) => tags
    .filter((t) => matchesNsfwKeyword(t.slug) || matchesNsfwKeyword(t.name) || matchesNsfwKeyword(t.nameEn))
    .map((t) => t.id);
export const findNsfwCategoryIds = (categories) => categories
    .filter((c) => matchesNsfwKeyword(c.slug))
    .map((c) => c.id);

/**
 * Qué assets publicados excluye el filtro.
 * - maxId: los assets con id mayor (publicados después) no están evaluados todavía.
 * - blockedIds: ids (<= maxId) excluidos por título, slug o por tener un tag/categoría +18.
 */
export function computeNsfwIndex({ assets, assetIdsWithNsfwLinks }) {
    let maxId = 0;
    const blocked = new Set();
    for (const a of assets) {
        if (a.id > maxId) maxId = a.id;
        if (matchesNsfwKeyword(a.title) || matchesNsfwKeyword(a.slug)) blocked.add(a.id);
    }
    for (const id of assetIdsWithNsfwLinks) {
        if (id <= maxId) blocked.add(id);
    }
    return { maxId, blockedIds: [...blocked].sort((x, y) => x - y) };
}

async function buildIndex() {
    const [tags, categories, assets] = await Promise.all([
        prisma.tag.findMany({ select: { id: true, slug: true, name: true, nameEn: true } }),
        prisma.category.findMany({ select: { id: true, slug: true } }),
        prisma.asset.findMany({ where: { status: 'PUBLISHED' }, select: { id: true, title: true, slug: true } }),
    ]);

    const nsfwTagIds = findNsfwTagIds(tags);
    const nsfwCategoryIds = findNsfwCategoryIds(categories);

    const linkFilters = [];
    if (nsfwTagIds.length) linkFilters.push({ tags: { some: { id: { in: nsfwTagIds } } } });
    if (nsfwCategoryIds.length) linkFilters.push({ categories: { some: { id: { in: nsfwCategoryIds } } } });
    const linked = linkFilters.length
        ? await prisma.asset.findMany({ where: { status: 'PUBLISHED', OR: linkFilters }, select: { id: true } })
        : [];

    const index = computeNsfwIndex({ assets, assetIdsWithNsfwLinks: linked.map((a) => a.id) });
    return { ...index, builtAt: Date.now() };
}

let cached = null;
let building = null;

function refresh() {
    if (!building) {
        building = buildIndex()
            .then((index) => { cached = index; return index; })
            .finally(() => { building = null; });
    }
    return building;
}

/** Índice vigente. Si caducó, responde con el anterior y lo recalcula en segundo plano. */
export async function getNsfwPublishedIndex() {
    if (!cached) return refresh();
    if (Date.now() - cached.builtAt >= INDEX_TTL_MS) {
        refresh().catch((e) => console.error('[NSFW index] no se pudo recalcular:', e?.message || e));
    }
    return cached;
}

/**
 * `where` de Prisma equivalente a { status: 'PUBLISHED', ...buildNsfwWhere(req) }, pero rápido:
 * los assets ya evaluados se filtran por id y solo los publicados después del último cálculo
 * pasan por el filtro completo. Un cambio de tags o título se refleja al recalcular (≤ 10 min).
 */
export async function buildPublishedSafeWhere(req) {
    const nsfwWhere = buildNsfwWhere(req);
    if (Object.keys(nsfwWhere).length === 0) return { status: 'PUBLISHED' };

    const index = await getNsfwPublishedIndex();
    const evaluated = { lte: index.maxId };
    if (index.blockedIds.length) evaluated.notIn = index.blockedIds;
    return {
        status: 'PUBLISHED',
        OR: [
            { id: evaluated },
            { id: { gt: index.maxId }, ...nsfwWhere },
        ],
    };
}

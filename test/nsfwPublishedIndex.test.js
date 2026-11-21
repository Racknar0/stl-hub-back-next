import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeNsfwIndex,
    findNsfwCategoryIds,
    findNsfwTagIds,
    matchesNsfwKeyword,
} from '../src/services/nsfwPublishedIndex.service.js';

test('keyword match ignores case and accents like LIKE with utf8mb4_unicode_ci', () => {
    assert.equal(matchesNsfwKeyword('Cráneo de dragón'), true);   // "craneo"
    assert.equal(matchesNsfwKeyword('FIGURA HENTAI'), true);
    assert.equal(matchesNsfwKeyword('stl---pin-up-girl'), true);
    assert.equal(matchesNsfwKeyword('Soporte de mando Pikachu'), false);
    assert.equal(matchesNsfwKeyword(null), false);
    assert.equal(matchesNsfwKeyword(''), false);
});

test('tags match on slug, name or nameEn; categories only on slug', () => {
    const tags = [
        { id: 1, slug: 'calavera', name: 'Cráneo', nameEn: null },
        { id: 2, slug: 'dragon', name: 'Dragón', nameEn: 'Dragon' },
        { id: 3, slug: 'x', name: 'x', nameEn: 'Skull' },
    ];
    assert.deepEqual(findNsfwTagIds(tags), [1, 3]);
    const categories = [
        { id: 10, slug: 'adultos', name: 'irrelevante' },
        { id: 11, slug: 'animales', name: 'adult' },
    ];
    assert.deepEqual(findNsfwCategoryIds(categories), [10]);
});

test('index blocks by title, slug and links, and only up to the newest evaluated id', () => {
    const assets = [
        { id: 5, title: 'STL - OVNI abduciendo vaca', slug: 'stl---ovni-abduciendo-vaca' },
        { id: 7, title: 'Busto sexy', slug: 'stl---busto' },
        { id: 9, title: 'Figura', slug: 'stl---figura-gore' },
        { id: 12, title: 'Dragón', slug: 'stl---dragon' },
    ];
    const index = computeNsfwIndex({ assets, assetIdsWithNsfwLinks: [12, 40] });
    assert.equal(index.maxId, 12);
    // 40 se publicó después de cargar la lista: no se marca, lo evalúa el filtro completo.
    assert.deepEqual(index.blockedIds, [7, 9, 12]);
});

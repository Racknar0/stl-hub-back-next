import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import pinterestService from './pinterest.service.js';
import qdrantMultimodalService from './qdrantMultimodal.service.js';
import { findForbiddenKeyword } from '../utils/pinterestForbiddenWords.js';

const prisma = new PrismaClient();

const MIN_SCORE = Number(process.env.PINTEREST_TREND_MIN_SCORE || 0.56);
const MIN_ASSETS_PER_TREND = 3;
const MAX_ASSETS_PER_TREND = 40;
const MAX_CHIPS = 12;

// Caché diaria en memoria: { day: 'YYYY-MM-DD', data }
let cache = null;

// Convierte tendencias reales de Pinterest (o, si no hay, la temporada actual) en búsquedas de modelos 3D.
// Una sola llamada a Gemini por día gracias a la caché.
async function getPrintableTrendKeywords(pinterestTrends) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const ai = new GoogleGenAI({ apiKey });
  const today = new Date().toISOString().slice(0, 10);
  const base = `Today is ${today}. You work for a site of 3D printable STL files (figures, busts, anime, movies, games, home decor, cosplay, toys, gadgets).`;
  const prompt = pinterestTrends.length > 0
    ? [
        base,
        'These are the keywords currently growing on Pinterest:',
        pinterestTrends.map(t => `- ${t.keyword}`).join('\n'),
        'Turn the ones that relate to physical objects into a short search keyword for 3D printable models (e.g. "anime halloween pfp" -> "anime halloween figure", "pumpkin painting ideas" -> "halloween pumpkin decor").',
        'Skip trends that cannot become a 3D printed object (wallpapers, chalkboards, outfits, recipes). Merge duplicates. Max 15.',
        'Respond ONLY with valid JSON: {"keywords": [{"keyword": "...", "from": "original pinterest trend"}]}',
      ].join('\n')
    : [
        base,
        'List 15 English search keywords that are trending or seasonally rising on Pinterest RIGHT NOW (upcoming holidays, seasons, new movies, games and series) and that match 3D printable models.',
        'Each keyword: 1-4 words. No adult content.',
        'Respond ONLY with valid JSON: {"keywords": [{"keyword": "...", "from": null}]}',
      ].join('\n');
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json' },
  });
  const parsed = JSON.parse(String(response?.text || '{}'));
  const growthByTrend = new Map(pinterestTrends.map(t => [t.keyword.toLowerCase(), t.growth]));
  return (parsed.keywords || [])
    .map(k => (typeof k === 'string' ? { keyword: k, from: null } : k))
    .filter(k => k?.keyword)
    .map(k => ({ keyword: k.keyword, from: k.from || null, growth: growthByTrend.get(String(k.from || '').toLowerCase()) ?? null }));
}

// Busca en Qdrant los assets publicables que encajan con una tendencia
async function matchAssetsForKeyword(keyword, excludedIds) {
  const results = await qdrantMultimodalService.searchByImage(null, null, keyword, 80, MIN_SCORE);
  const ids = (results || []).map(r => Number(r.id)).filter(id => id && !excludedIds.has(id));
  if (ids.length === 0) return [];

  const assets = await prisma.asset.findMany({
    where: { id: { in: ids }, status: 'PUBLISHED' },
    select: {
      id: true, title: true, titleEn: true, description: true, descriptionEn: true, slug: true,
      categories: { select: { name: true, slug: true } },
      tags: { select: { name: true, nameEn: true } },
    },
  });

  const isAdult = (a) =>
    a.categories.some(c => findForbiddenKeyword(c.name) || findForbiddenKeyword(c.slug)) ||
    a.tags.some(t => findForbiddenKeyword(t.name) || findForbiddenKeyword(t.nameEn)) ||
    [a.title, a.titleEn, a.description, a.descriptionEn, a.slug].some(findForbiddenKeyword);

  const allowed = new Set(assets.filter(a => !isAdult(a)).map(a => a.id));
  // Mantener el orden de relevancia de Qdrant
  return ids.filter(id => allowed.has(id)).slice(0, MAX_ASSETS_PER_TREND);
}

export async function getTrendSuggestions({ refresh = false } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  if (!refresh && cache?.day === day) return { ...cache.data, cached: true };

  let source = 'pinterest';
  let pinterestTrends = [];
  let pinterestError = null;
  try {
    pinterestTrends = await pinterestService.getTrendKeywords({ limit: 50 });
  } catch (e) {
    pinterestError = e.message;
    console.warn('[PINTEREST][TRENDS] Trends API no disponible, usando temporada con Gemini:', e.message);
  }
  if (pinterestTrends.length === 0) source = 'gemini';
  let keywords = await getPrintableTrendKeywords(pinterestTrends);

  keywords = keywords.filter(k => k.keyword && !findForbiddenKeyword(k.keyword));

  const queued = await prisma.pinterestPinQueue.findMany({ select: { assetId: true } });
  const excludedIds = new Set(queued.map(p => p.assetId));

  // Embeddings en lotes pequeños para no saturar Gemini
  const chips = [];
  for (let i = 0; i < keywords.length; i += 5) {
    const batch = keywords.slice(i, i + 5);
    const matches = await Promise.all(batch.map(k =>
      matchAssetsForKeyword(k.keyword, excludedIds).catch(e => {
        console.warn(`[PINTEREST][TRENDS] Error buscando "${k.keyword}":`, e.message);
        return [];
      })
    ));
    batch.forEach((k, idx) => {
      if (matches[idx].length >= MIN_ASSETS_PER_TREND) {
        chips.push({ keyword: k.keyword, from: k.from, growth: k.growth, count: matches[idx].length, assetIds: matches[idx] });
      }
    });
  }

  chips.sort((a, b) => b.count - a.count);
  const data = { source, pinterestError, generatedAt: new Date().toISOString(), trends: chips.slice(0, MAX_CHIPS) };
  cache = { day, data };
  return { ...data, cached: false };
}

export default { getTrendSuggestions };

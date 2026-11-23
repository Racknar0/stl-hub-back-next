// Tendencias para los textos automáticos de los reels.
// - Recolector: cada ~6 h guarda lo que está en tendencia en Google Trends, Pinterest Trends, YouTube (populares),
//   Bluesky y Mastodon (todas gratis o dentro de las APIs ya conectadas).
// - Calendario: fechas conocidas de antemano (Black Friday, Navidad, Halloween…), calculadas en código.
// - Ángulo: la IA decide, para un modelo concreto, qué tendencias encajan de verdad y escribe un "puente" creativo
//   con la tendencia más fuerte del día, que solo se usa como frase de enganche (nunca en títulos ni hashtags).
import { GoogleGenAI } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import pinterestService from './pinterest.service.js';
import { mostPopular } from './youtube.service.js';

const prisma = new PrismaClient();
const COLLECT_EVERY_MS = 6 * 3600 * 1000;
const PER_SOURCE = 15;

// ---------- Fuentes ----------
const decodeXml = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

/** Búsquedas del día en Google Trends (feed RSS público). */
export function parseGoogleTrendsRss(xml) {
  const items = String(xml || '').split('<item>').slice(1);
  return items.map((it) => {
    const term = decodeXml((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const traffic = Number(String((it.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1] || '').replace(/[^\d]/g, '')) || null;
    return { term, score: traffic };
  }).filter(t => t.term);
}

async function fromGoogle() {
  const res = await fetch('https://trends.google.com/trending/rss?geo=US', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; trends-reader)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGoogleTrendsRss(await res.text());
}

async function fromPinterest() {
  const list = await pinterestService.getTrendKeywords({ limit: 50 });
  return list.map(t => ({ term: t.keyword, score: t.growth != null ? Math.round(t.growth) : null }));
}

async function fromYoutube() {
  const [gaming, film, ent] = await Promise.all([
    mostPopular({ categoryId: '20' }).catch(() => []),
    mostPopular({ categoryId: '1' }).catch(() => []),
    mostPopular({ categoryId: '24' }).catch(() => []),
  ]);
  return [...gaming, ...film, ...ent].map(v => ({ term: v.title.slice(0, 190), score: Math.min(v.views, 2_000_000_000) }));
}

async function fromBluesky() {
  const res = await fetch('https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrendingTopics?limit=25');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return [...(data.topics || []), ...(data.suggested || [])].map((t, i) => ({ term: t.topic || t.displayName, score: 100 - i })).filter(t => t.term);
}

async function fromMastodon() {
  const res = await fetch('https://mastodon.social/api/v1/trends/tags?limit=20');
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (Array.isArray(data) ? data : []).map(t => ({
    term: `#${t.name}`,
    score: (t.history || []).slice(0, 2).reduce((s, h) => s + Number(h.uses || 0), 0),
  }));
}

const SOURCES = { google: fromGoogle, pinterest: fromPinterest, youtube: fromYoutube, bluesky: fromBluesky, mastodon: fromMastodon };

/** Recoge las tendencias de todas las fuentes (las que fallen se saltan) y las guarda juntas. */
export async function collectTrends() {
  const collectedAt = new Date();
  const summary = {};
  const rows = [];
  for (const [source, fn] of Object.entries(SOURCES)) {
    try {
      const list = (await fn()).filter(t => t.term).slice(0, 40);
      list.forEach(t => rows.push({ collectedAt, source, term: String(t.term).slice(0, 200), score: Number.isFinite(t.score) ? Math.round(t.score) : null }));
      summary[source] = list.length;
    } catch (e) {
      summary[source] = `error: ${e.message}`.slice(0, 120);
    }
  }
  if (rows.length) await prisma.trendTopic.createMany({ data: rows });
  // Se guardan solo 14 días
  await prisma.trendTopic.deleteMany({ where: { collectedAt: { lt: new Date(Date.now() - 14 * 86400000) } } }).catch(() => {});
  console.log('[TRENDS] Recogidas:', JSON.stringify(summary));
  return summary;
}

let trendsTimer = null;
/** Tarea interna: cada 30 min mira si la última recogida tiene más de 6 h (un reinicio no hace perder el día). */
export function startTrendsScheduler() {
  if (trendsTimer) return;
  const tick = async () => {
    try {
      const last = await prisma.trendTopic.findFirst({ orderBy: { collectedAt: 'desc' }, select: { collectedAt: true } });
      if (!last || Date.now() - last.collectedAt.getTime() >= COLLECT_EVERY_MS) await collectTrends();
    } catch (e) { console.error('[TRENDS] Recolector:', e.message); }
  };
  setTimeout(tick, 2 * 60000);
  trendsTimer = setInterval(tick, 30 * 60000);
}

/** Tendencias de la última recogida de cada fuente (de las últimas 30 h), las más fuertes primero. */
export async function latestTrends() {
  const since = new Date(Date.now() - 30 * 3600 * 1000);
  const rows = await prisma.trendTopic.findMany({ where: { collectedAt: { gte: since } }, orderBy: { collectedAt: 'desc' } });
  const bySource = {};
  const lastAt = {};
  for (const r of rows) {
    lastAt[r.source] ||= r.collectedAt.getTime();
    if (r.collectedAt.getTime() !== lastAt[r.source]) continue;
    (bySource[r.source] ||= []).push(r);
  }
  for (const s of Object.keys(bySource)) {
    bySource[s] = bySource[s].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, PER_SOURCE).map(r => r.term);
  }
  return bySource;
}

// ---------- Calendario ----------
const nthWeekday = (year, month, weekday, n) => {
  const d = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
};

/** Fechas conocidas de antemano en los próximos `days` días: [{ name, date: 'YYYY-MM-DD', daysLeft }]. */
export function upcomingEvents(from = new Date(), days = 21) {
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const out = [];
  for (const year of [from.getUTCFullYear(), from.getUTCFullYear() + 1]) {
    const thanksgiving = nthWeekday(year, 10, 4, 4);
    const list = [
      ['New Year', new Date(Date.UTC(year, 0, 1))],
      ["Valentine's Day", new Date(Date.UTC(year, 1, 14))],
      ["St. Patrick's Day", new Date(Date.UTC(year, 2, 17))],
      ['Star Wars Day (May the 4th)', new Date(Date.UTC(year, 4, 4))],
      ['Free Comic Book Day', nthWeekday(year, 4, 6, 1)],
      ["Mother's Day (US)", nthWeekday(year, 4, 0, 2)],
      ["Father's Day", nthWeekday(year, 5, 0, 3)],
      ['Back to School', new Date(Date.UTC(year, 7, 15))],
      ['Halloween', new Date(Date.UTC(year, 9, 31))],
      ['Day of the Dead', new Date(Date.UTC(year, 10, 2))],
      ['Thanksgiving (US)', thanksgiving],
      ['Black Friday', new Date(thanksgiving.getTime() + 86400000)],
      ['Cyber Monday', new Date(thanksgiving.getTime() + 4 * 86400000)],
      ['Christmas', new Date(Date.UTC(year, 11, 25))],
    ];
    for (const [name, date] of list) {
      const daysLeft = Math.round((date.getTime() - start) / 86400000);
      if (daysLeft >= 0 && daysLeft <= days) out.push({ name, date: date.toISOString().slice(0, 10), daysLeft });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

// ---------- Ángulo para un modelo ----------
function parseJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No se pudo leer el ángulo de tendencia');
    return JSON.parse(m[0]);
  }
}

/**
 * Pide a la IA el ángulo de tendencia para un modelo: tendencias que encajan de verdad, fecha cercana útil,
 * un puente creativo con la tendencia más fuerte (aunque no tenga relación) y hashtags/keywords relacionados.
 */
export async function pickTrendAngle({ asset, trends, events, language = 'en' }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const ai = new GoogleGenAI({ apiKey });
  const lang = language === 'es' ? 'Spanish' : 'English';
  const prompt = [
    'You help a 3D printing site (it SELLS premium STL files) ride today\'s trends in its social posts.',
    `Write any text values in ${lang}.`,
    'MODEL OF TODAY\'S POST:',
    `- Title: ${asset?.titleEn || asset?.title || 'N/A'}`,
    `- Categories: ${(asset?.categories || []).map(c => c.nameEn || c.name).join(', ') || 'N/A'}`,
    `- Tags: ${(asset?.tags || []).map(t => t.nameEn || t.name).slice(0, 15).join(', ') || 'N/A'}`,
    '',
    'TODAY\'S TRENDS BY SOURCE:',
    ...Object.entries(trends || {}).map(([s, list]) => `- ${s}: ${list.join(' | ')}`),
    '',
    `UPCOMING DATES: ${events?.length ? events.map(e => `${e.name} in ${e.daysLeft} days`).join(', ') : 'none soon'}`,
    '',
    'Return ONLY JSON with this shape:',
    '{"related": ["trends/keywords GENUINELY related to the model: same franchise, character, theme, genre, or what the object is used for"],',
    ' "keywords": ["up to 4 search phrases people type that fit the model and today (for YouTube/Pinterest titles)"],',
    ' "seasonal": {"event": "upcoming date that fits", "daysLeft": 0, "angle": "e.g. gift idea, Halloween decor"} or null,',
    ' "bridge": {"trend": "the strongest trend of the day, even if unrelated", "hook": "ONE short, witty opening line that links that trend with the model WITHOUT lying (e.g. \\"While we wait for GTA VI on PC, print this epic treasure chest\\")"} or null,',
    ' "hashtags": ["up to 5 hashtags without #, CamelCase, that are RELATED to the model or to the 3D printing niche and trending if possible"]}',
    'RULES: never claim the model belongs to an unrelated franchise; the bridge must read as a playful comparison, not as a fact about the model;',
    'skip tragedies, deaths, disasters, politics, crime and elections for the bridge (use the next strongest trend);',
    'the STL files are PAID: never write free, gratis or similar; no URLs.',
  ].join('\n');
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [prompt],
    config: { responseMimeType: 'application/json', temperature: 0.8 },
  });
  const p = parseJson(response?.text);
  const clean = (v) => String(v || '').trim();
  return {
    related: (Array.isArray(p.related) ? p.related : []).map(clean).filter(Boolean).slice(0, 6),
    keywords: (Array.isArray(p.keywords) ? p.keywords : []).map(clean).filter(Boolean).slice(0, 4),
    seasonal: p.seasonal?.event ? { event: clean(p.seasonal.event), daysLeft: Number(p.seasonal.daysLeft) || null, angle: clean(p.seasonal.angle) } : null,
    bridge: p.bridge?.trend && p.bridge?.hook && !/\b(free|gratis|gratuit)/i.test(p.bridge.hook) ? { trend: clean(p.bridge.trend), hook: clean(p.bridge.hook) } : null,
    hashtags: (Array.isArray(p.hashtags) ? p.hashtags : []).map(h => String(h).replace(/[#\s]+/g, '')).filter(Boolean).slice(0, 5),
  };
}

/**
 * Brief que se añade a los prompts de textos: qué se puede usar y dónde. Las tendencias relacionadas y la fecha van
 * en cualquier campo; el puente (tendencia sin relación) solo como frase de enganche de los textos sociales.
 */
export function buildTrendBrief(angle) {
  if (!angle) return '';
  const lines = ["## TODAY'S TREND BRIEF (use it to get more reach, following these rules)"];
  if (angle.related.length || angle.keywords.length) lines.push(`- Related trends/keywords (OK anywhere: titles, descriptions, hashtags): ${[...angle.related, ...angle.keywords].join(', ')}`);
  if (angle.seasonal) lines.push(`- Seasonal angle (OK anywhere): ${angle.seasonal.event}${angle.seasonal.daysLeft != null ? ` in ${angle.seasonal.daysLeft} days` : ''} → ${angle.seasonal.angle}`);
  if (angle.bridge) lines.push(`- Bridge hook with an UNRELATED trend ("${angle.bridge.trend}"): use it ONLY as the opening line of social captions (Instagram/Facebook bodies) and optionally in the YouTube description. NEVER put it in the YouTube title, the hashtags or Pinterest texts. Suggested line: "${angle.bridge.hook}" (rephrase it for each version).`);
  if (angle.hashtags.length) lines.push(`- Trending hashtags you may use (they are related to the model or the niche): ${angle.hashtags.join(', ')}`);
  lines.push('- Never pretend the model is part of an unrelated franchise. Keep the model name first in titles.');
  return lines.join('\n');
}

export default { collectTrends, startTrendsScheduler, latestTrends, upcomingEvents, pickTrendAngle, buildTrendBrief, parseGoogleTrendsRss };

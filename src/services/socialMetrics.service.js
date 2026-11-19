// Métricas por publicación en todas las redes (Facebook, Instagram, YouTube, Pinterest y Threads) para el panel del dashboard.
// Se toman los reels publicados por el sistema cuya hora de publicación cae en el rango pedido (como "Fecha de publicación"
// de Business Suite) y se consultan las APIs de cada red. Cada consulta se cachea unos minutos para no gastar cuota.
import { PrismaClient } from '@prisma/client';
import youtube from './youtube.service.js';
import threads from './threads.service.js';
import pinterestService from './pinterest.service.js';
import { listFacebookPages, listInstagramAccounts, facebookReelMetrics, instagramMediaMetrics } from './metaReels.service.js';

const prisma = new PrismaClient();
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // clave -> { at, value }

const NETWORK_LABEL = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads' };

async function cached(key, loader, fresh = false) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Ejecuta tareas con un máximo de concurrencia para no saturar las APIs
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const EMPTY = { views: null, reach: null, likes: null, comments: null, shares: null, saves: null, clicks: null, avgWatchSec: null, totalWatchSec: null };

/**
 * Filas de métricas de los reels publicados entre `from` y `to` (fechas ISO), más la fila resumen de Pinterest.
 * `networks` (opcional) limita a algunas redes. Con `fresh` se ignora lo guardado y se consulta cada red en vivo.
 */
export async function getSocialMetrics({ from, to, networks = null, fresh = false }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(+start) || Number.isNaN(+end) || end < start) throw new Error('Rango de fechas no válido');
  const want = (n) => !networks || networks.includes(n);

  // Las cuentas extra publican horas después: se amplía la búsqueda y luego se filtra por la hora real de cada red
  const posts = await prisma.reelPost.findMany({
    where: { status: 'PUBLISHED', simulated: false, publishedAt: { gte: new Date(start.getTime() - 3 * 86400000), lte: new Date(end.getTime() + 86400000) } },
    orderBy: { publishedAt: 'desc' },
    select: { id: true, title: true, assetTitle: true, publishedAt: true, results: true },
  });

  const [pages, igAccounts, ytChannels, threadsStatus] = await Promise.all([
    listFacebookPages().catch(() => []),
    listInstagramAccounts().catch(() => []),
    youtube.listChannels().catch(() => []),
    threads.connectionStatus().catch(() => ({})),
  ]);
  const pageName = Object.fromEntries(pages.map(p => [p.id, p.name]));
  const igName = Object.fromEntries(igAccounts.map(a => [a.id, `@${a.username}`]));
  const ytName = Object.fromEntries(ytChannels.map(c => [c.id, c.title]));
  const primaryYt = ytChannels[0]?.id;

  // 1. Entradas (una por post y red/cuenta) dentro del rango
  const entries = [];
  for (const post of posts) {
    for (const [key, r] of Object.entries(post.results || {})) {
      if (!r?.id || r.simulated || r.deferred || r.failed) continue;
      const [network, account] = key.split(':');
      if (!NETWORK_LABEL[network] || !want(network)) continue;
      const when = new Date(r.publishedAt || r.publishAt || post.publishedAt);
      if (when < start || when > end) continue;
      let accountId = account || (network === 'facebook' ? r.pageId : network === 'instagram' ? r.igUserId : network === 'youtube' ? primaryYt : null);
      const label = network === 'facebook' ? pageName[accountId] || r.pageId
        : network === 'instagram' ? igName[accountId] || (r.username ? `@${r.username}` : '')
          : network === 'youtube' ? ytName[accountId] || ''
            : network === 'threads' ? (threadsStatus.account?.username ? `@${threadsStatus.account.username}` : '')
              : '';
      entries.push({ postId: post.id, title: post.title || post.assetTitle || `Reel ${post.id}`, network, key, id: r.id, url: r.url || null, publishedAt: when.toISOString(), accountId, account: label || NETWORK_LABEL[network], pageId: r.pageId, when });
    }
  }

  // 2. YouTube: una sola llamada por canal con todos sus videos
  const ytByChannel = {};
  for (const e of entries.filter(x => x.network === 'youtube')) (ytByChannel[e.accountId] ||= []).push(e.id);
  const ytStats = {};
  await Promise.all(Object.entries(ytByChannel).map(async ([channelId, ids]) => {
    try {
      Object.assign(ytStats, await cached(`yt:${channelId}:${ids.sort().join(',')}`, () => youtube.videoStats(channelId, ids), fresh));
    } catch (e) { ids.forEach(id => { ytStats[id] = { error: e.message }; }); }
  }));

  // 3. Resto de redes: una llamada por publicación
  const todayStr = ymd(new Date());
  const rows = await pool(entries, 6, async (e) => {
    const base = { postId: e.postId, title: e.title, network: e.network, account: e.account, publishedAt: e.publishedAt, url: e.url, ...EMPTY };
    try {
      let m = {};
      if (e.network === 'facebook') m = await cached(`fb:${e.id}`, () => facebookReelMetrics({ pageId: e.pageId || e.accountId, videoId: e.id }), fresh);
      else if (e.network === 'instagram') m = await cached(`ig:${e.id}`, () => instagramMediaMetrics({ mediaId: e.id }), fresh);
      else if (e.network === 'youtube') { m = ytStats[e.id] || {}; if (m.error) throw new Error(m.error); }
      else if (e.network === 'threads') m = await cached(`th:${e.id}`, () => threads.postInsights(e.id), fresh);
      else if (e.network === 'pinterest') {
        const p = await cached(`pin:${e.id}:${todayStr}`, () => pinterestService.getPinAnalytics(e.id, ymd(e.when), todayStr), fresh);
        m = { views: p.VIDEO_MRC_VIEW ?? p.IMPRESSION ?? 0, saves: p.SAVE ?? 0, clicks: (p.OUTBOUND_CLICK ?? 0) + (p.PIN_CLICK ?? 0), avgWatchSec: p.VIDEO_AVG_WATCH_TIME ? Math.round(p.VIDEO_AVG_WATCH_TIME / 100) / 10 : null };
        m.reach = p.IMPRESSION ?? null; // impresiones = alcance aproximado en Pinterest
      }
      return { ...base, ...m };
    } catch (err) {
      return { ...base, error: err.message.replace(/\s+/g, ' ').slice(0, 160) };
    }
  });

  // 4. Fila resumen de Pinterest: toda la cuenta en el rango (los pines del piloto automático van agrupados)
  let pinterest = null;
  if (want('pinterest')) {
    try {
      const startDay = ymd(start);
      const endDay = ymd(end > new Date() ? new Date() : end);
      const [acct, pins] = await Promise.all([
        cached(`pinacct:${startDay}:${endDay}`, () => pinterestService.getAccountAnalytics(startDay, endDay), fresh),
        prisma.pinterestPinQueue.count({ where: { status: 'PUBLISHED', scheduledAt: { gte: start, lte: end } } }),
      ]);
      pinterest = { network: 'pinterest', account: 'Pinterest · todos los pines', pins, views: acct.IMPRESSION ?? 0, clicks: (acct.OUTBOUND_CLICK ?? 0) + (acct.PIN_CLICK ?? 0), saves: acct.SAVE ?? 0 };
    } catch (err) {
      pinterest = { network: 'pinterest', account: 'Pinterest · todos los pines', error: err.message.slice(0, 160) };
    }
  }

  return { from: start.toISOString(), to: end.toISOString(), rows, pinterest, generatedAt: new Date().toISOString() };
}

export default { getSocialMetrics };

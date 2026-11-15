import { resolveShortLink, listShortLinks, createShortLink } from '../services/shortLinks.service.js';

/**
 * GET /api/s/:code (público). Lo llama la ruta /v/<code> del front para redirigir.
 * Devuelve { url } y suma el clic; el front reenvía el user-agent del visitante para no contar bots.
 */
export async function resolveShortLinkController(req, res) {
  try {
    const userAgent = req.get('x-visitor-user-agent') || req.get('user-agent') || '';
    const url = await resolveShortLink(req.params.code, { userAgent });
    if (!url) return res.status(404).json({ error: 'Enlace no encontrado' });
    res.set('Cache-Control', 'no-store');
    return res.json({ url });
  } catch (e) {
    console.error('[SHORT] Error resolviendo enlace:', e.message);
    return res.status(500).json({ error: 'No se pudo resolver el enlace' });
  }
}

/** GET /api/admin/short-links (admin): enlaces cortos con sus clics y totales por origen. */
export async function listShortLinksController(req, res) {
  try {
    const { source, q, limit } = req.query || {};
    const data = await listShortLinks({ source: source ? String(source) : null, q: q ? String(q).slice(0, 100) : '', limit });
    return res.json(data);
  } catch (e) {
    console.error('[SHORT] Error listando enlaces:', e.message);
    return res.status(500).json({ error: 'No se pudieron cargar los enlaces cortos' });
  }
}

/**
 * POST /api/admin/short-links (admin): crea (o reutiliza) enlaces cortos a mano, p. ej. para TikTok.
 * Body: { links: [{ targetUrl, source, label? }] } con destinos solo de stlgratis.com (máx. 30).
 */
export async function createShortLinksController(req, res) {
  try {
    const links = Array.isArray(req.body?.links) ? req.body.links.slice(0, 30) : [];
    if (!links.length) return res.status(400).json({ error: 'Falta la lista de enlaces' });
    const out = [];
    for (const l of links) {
      const targetUrl = String(l?.targetUrl || '').trim();
      const source = String(l?.source || '').trim();
      if (!/^https:\/\/(www\.)?stlgratis\.com\//.test(targetUrl)) return res.status(400).json({ error: `Destino no permitido: ${targetUrl.slice(0, 80)}` });
      if (!/^[a-z0-9_]{2,40}$/.test(source)) return res.status(400).json({ error: 'Origen no válido (solo minúsculas, números y _)' });
      out.push({ targetUrl, url: await createShortLink({ targetUrl, source, label: l.label ? String(l.label) : null, refType: 'manual' }) });
    }
    return res.json({ links: out });
  } catch (e) {
    console.error('[SHORT] Error creando enlaces:', e.message);
    return res.status(500).json({ error: 'No se pudieron crear los enlaces cortos' });
  }
}

export default { resolveShortLinkController, listShortLinksController, createShortLinksController };

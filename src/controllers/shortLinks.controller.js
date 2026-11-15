import { resolveShortLink, listShortLinks } from '../services/shortLinks.service.js';

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

export default { resolveShortLinkController, listShortLinksController };

import { getHeroBannersService, heroVariantFromCookie, newHeroSeed, chooseHeroVariant, HERO_COOKIE } from '../services/heroBanners.service.js';

export function sendHeroError(res, error) {
  if (!error.status) console.error('[hero-banners]', error.message);
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'No se pudo guardar o cargar el banner.', code: error.code || 'HERO_BANNER_ERROR', ...(error.fields ? { fields: error.fields } : {}) });
}

export function createHeroRenderHandler({ service = null, randomSeed = newHeroSeed, production = process.env.NODE_ENV === 'production' } = {}) {
  return async (req, res) => {
    const { lang, device } = req.params;
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    if (!['es', 'en'].includes(lang) || !['desktop', 'mobile'].includes(device)) return res.status(400).json({ error: 'Idioma o dispositivo inválido.', code: 'INVALID_RENDER_TARGET' });
    try {
      const variants = await (service || getHeroBannersService()).listPublic();
      // Cada recarga elige otro diseño; la cookie solo recuerda el último mostrado.
      const variant = chooseHeroVariant(variants, randomSeed(), heroVariantFromCookie(req.headers.cookie));
      if (variant) {
        const slot = `${lang}${device === 'desktop' ? 'Desktop' : 'Mobile'}`;
        res.cookie(HERO_COOKIE, variant.id, { httpOnly: true, sameSite: 'lax', secure: production, path: '/' });
        res.set('X-Hero-Variant', variant.id);
        return res.redirect(302, variant.images[slot].url);
      }
    } catch (error) {
      console.error('[hero-banners] render fallback:', error.message);
    }
    res.set('X-Hero-Variant', 'fallback');
    return res.redirect(302, `/hero/hero-${device}-${lang}.png`);
  };
}

export async function listPublicHeroBanners(req, res) {
  try { res.set('Cache-Control', 'public, max-age=30'); return res.json({ variants: await getHeroBannersService().listPublic() }); }
  catch (error) { return sendHeroError(res, error); }
}
export async function listAdminHeroBanners(req, res) {
  try { res.set('Cache-Control', 'private, no-store'); return res.json({ variants: await getHeroBannersService().listAdmin() }); }
  catch (error) { return sendHeroError(res, error); }
}
export async function createHeroBanner(req, res) {
  try { const { variant } = await getHeroBannersService().create(req.body, req.files); return res.status(201).json({ variant }); }
  catch (error) { return sendHeroError(res, error); }
}
export async function updateHeroBanner(req, res) {
  try { return res.json({ variant: await getHeroBannersService().update(req.params.id, req.body) }); }
  catch (error) { return sendHeroError(res, error); }
}
export async function archiveHeroBanner(req, res) {
  try { return res.json({ variant: await getHeroBannersService().archive(req.params.id) }); }
  catch (error) { return sendHeroError(res, error); }
}

import geoip from 'geoip-lite';

/**
 * Obtiene el código de país ISO 3166-1 alpha-2 a partir de una IP.
 * Usa la base de datos embebida de geoip-lite (MaxMind GeoLite2).
 * @param {string} ip - Dirección IP (IPv4 o IPv6)
 * @returns {string|null} Código de país ("US", "CO", "ES"...) o null
 */
export function getCountryFromIp(ip) {
    if (!ip) return null;
    // Limpiar prefijo IPv6-mapped IPv4 (::ffff:192.168.1.1 → 192.168.1.1)
    const cleanIp = ip.replace(/^::ffff:/, '');
    // Ignorar IPs locales/privadas
    if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.startsWith('192.168.') || cleanIp.startsWith('10.')) {
        return null;
    }
    const geo = geoip.lookup(cleanIp);
    return geo?.country || null;
}

/**
 * Extrae la IP real del cliente considerando Cloudflare y proxies.
 * Prioridad: CF-Connecting-IP → X-Forwarded-For (primer valor) → req.ip
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export function getClientIp(req) {
    // Cloudflare siempre envía la IP real del visitante en este header
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp.trim();

    // Fallback: X-Forwarded-For (primer IP = cliente original)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();

    // Fallback final: req.ip (funciona si trust proxy está habilitado)
    return req.ip || req.connection?.remoteAddress || null;
}

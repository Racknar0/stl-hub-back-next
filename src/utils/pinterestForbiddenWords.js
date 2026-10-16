// Lista única de palabras no permitidas en pines de Pinterest.
// La usan el prompt de IA, el saneado de respuestas y la validación de /schedule.
export const FORBIDDEN_KEYWORDS = ['nsfw', 'sexy', 'hentai', 'nude', 'nudeza', 'adulto', 'adult', 'erotic', 'porn', 'sensual', '18+', '+18', 'r18', 'r-18'];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Coincide con la palabra completa que contiene el término prohibido (ej. "Adults", "sexy-pose")
const FORBIDDEN_REGEX = new RegExp(`[\\w-]*(?:${FORBIDDEN_KEYWORDS.map(escapeRegex).join('|')})[\\w-]*`, 'gi');

export function findForbiddenKeyword(text) {
  const clean = String(text || '').toLowerCase();
  return FORBIDDEN_KEYWORDS.find(kw => clean.includes(kw)) || null;
}

// Elimina las palabras prohibidas de un texto sin regenerarlo
export function stripForbiddenWords(text) {
  if (!text) return text;
  return String(text)
    .replace(FORBIDDEN_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    // Conectores que quedan colgando tras quitar la palabra ("A and elf", "for , collectors")
    .replace(/\b(a|an|the|very|so)\s+(and|or|&)\s+/gi, '$1 ')
    .replace(/\s+(and|or|&)\s+(and|or|&)\s+/gi, ' $1 ')
    .replace(/\s+(and|or|&)\s*(?=[,.!?;:]|$)/gi, '')
    .replace(/\b(for|with|to|of)\s*,\s*/gi, '$1 ')
    .replace(/\(\s*\)/g, '')
    .replace(/\s*\|\s*(?=\||$)/g, '')
    .replace(/^\s*\|\s*/, '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/,(?=\s*[.!?])/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Sanea una variación generada por IA: limpia título y descripción y descarta hashtags con palabras prohibidas
export function sanitizePinVariation(variation) {
  const removed = [];
  const track = (text) => {
    const found = FORBIDDEN_KEYWORDS.filter(kw => String(text || '').toLowerCase().includes(kw));
    removed.push(...found);
    return found.length > 0 ? stripForbiddenWords(text) : text;
  };
  const pinTitle = track(variation.pinTitle);
  const pinDescription = track(variation.pinDescription);
  const pinHashtags = (variation.pinHashtags || []).filter(h => {
    const kw = findForbiddenKeyword(h);
    if (kw) removed.push(kw);
    return !kw;
  });
  return { variation: { ...variation, pinTitle, pinDescription, pinHashtags }, removed: Array.from(new Set(removed)) };
}

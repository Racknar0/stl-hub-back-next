/**
 * textUtils.js — Utilidades de normalización y procesamiento de texto para el backend.
 */

// Caché en memoria para evitar reprocesamiento repetitivo de CPU en grandes colecciones
const canonicalCache = new Map(); // id -> key

/**
 * Normaliza y limpia un string eliminando acentos, puntuación y caracteres especiales.
 * @param {string} str String de entrada
 * @returns {string} String normalizado en minúsculas
 */
function cleanString(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Eliminar acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]+/g, ' ') // Mantener solo caracteres alfanuméricos y separadores básicos
    .replace(/[\s-_]+/g, ' ') // Comprimir espacios y guiones múltiples
    .trim();
}

/**
 * Genera una clave canónica a partir de un título principal y opcionalmente un título en inglés.
 * Divide los títulos en palabras, elimina palabras vacías (stopwords), prefijos y sufijos de relleno,
 * ordena las palabras alfabéticamente y las concatena.
 * 
 * @param {string} title Título en español
 * @param {string} [titleEn] Título en inglés (opcional)
 * @returns {string} Clave canónica ordenada
 */
export function generateCanonicalTitleKey(title, titleEn = '') {
  const stopwords = new Set([
    // Español
    'stl', 'de', 'con', 'para', 'el', 'la', 'un', 'una', 'en', 'del', 'los', 'las', 'y', 'o', 'a', 'al', 'es', 'se', 'por', 'lo',
    // Inglés
    'the', 'of', 'and', 'with', 'for', 'a', 'an', 'in', 'on', 'at', 'by', 'to', 'from', 'as', 'or', 'is', 'it', 'this', 'that',
    // Relleno común en modelos 3D
    'figura', 'figure', 'figuras', 'pack', 'soporte', 'base', 'stand', 'holder'
  ]);

  const words = [];
  
  const addTokens = (text) => {
    const rawClean = cleanString(text);
    if (!rawClean) return;
    rawClean.split(' ').forEach(w => {
      // Omitimos palabras de 1 letra (ej: '2', 'a', 'x') y stopwords
      if (w.length > 1 && !stopwords.has(w)) {
        words.push(w);
      }
    });
  };

  addTokens(title);
  if (titleEn) addTokens(titleEn);

  // Eliminar duplicados y ordenar alfabéticamente para ignorar el orden original
  const uniqueSorted = Array.from(new Set(words)).sort();
  return uniqueSorted.join(' ');
}

/**
 * Obtiene la clave canónica de un asset utilizando la caché en memoria para maximizar el rendimiento.
 * 
 * @param {number} id ID del asset
 * @param {string} title Título en español
 * @param {string} [titleEn] Título en inglés
 * @returns {string} Clave canónica (desde caché o calculada)
 */
export function getCachedCanonicalKey(id, title, titleEn = '') {
  const numericId = Number(id);
  if (!numericId) return generateCanonicalTitleKey(title, titleEn);

  let cached = canonicalCache.get(numericId);
  if (!cached || cached.title !== title || cached.titleEn !== titleEn) {
    const key = generateCanonicalTitleKey(title, titleEn);
    cached = { title, titleEn, key };
    canonicalCache.set(numericId, cached);
  }
  return cached.key;
}

/**
 * Limpia la caché de un asset específico (útil en eliminaciones o ediciones).
 * @param {number} id ID del asset
 */
export function invalidateCanonicalCache(id) {
  canonicalCache.delete(Number(id));
}

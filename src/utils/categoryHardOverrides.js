/**
 * Definición centralizada de las reglas de anulación estricta (hard overrides)
 * para categorías y tags basados en el nombre o título del archivo.
 */
export const categoryHardOverrideRules = [
  {
    regex: /\b(busto|bust|bustos|busts)\b/i,
    categoryTerms: ['busto', 'bust', 'bustos', 'busts'],
    tagTerms: ['busto', 'bust', 'bustos', 'busts'],
    slug: 'busto'
  },
  {
    regex: /(flexi|flexible|articulado|articuled|articulated)/i,
    categoryTerms: ['articulados', 'articulado', 'articulated'],
    tagTerms: ['articulado', 'articulated', 'flexible', 'flexi'],
    slug: 'articulados'
  },
  {
    regex: /(keychain|llavero)/i,
    categoryTerms: ['llavero', 'llaveros', 'keychains', 'keychain'],
    tagTerms: ['llavero', 'keychain', 'llaveros', 'keychains'],
    slug: 'llavero'
  },
  {
    regex: /(helmet|mask|armor|casco|mascara|armadura)/i,
    categoryTerms: ['cosplay'],
    tagTerms: ['cosplay', 'casco', 'mascara', 'armadura', 'helmet', 'mask', 'armor'],
    slug: 'cosplay'
  },
  {
    regex: /(mug|cup|taza|vaso)/i,
    categoryTerms: ['mugs', 'mug', 'mugs-y-tazas', 'tazas', 'taza', 'vasos', 'vaso'],
    tagTerms: ['mug', 'mugs', 'taza', 'tazas', 'vaso', 'vasos', 'cup', 'cups'],
    slug: 'mugs'
  },
  {
    regex: /(maceta|macetas|planta|plantas|planter|planters|pot|pots|plant|plants)/i,
    categoryTerms: ['macetas y jardín', 'macetas-y-jardn', 'macetas', 'pots', 'planters', 'planter'],
    tagTerms: ['macetas', 'pots', 'maceta', 'pot', 'planta', 'plant', 'plantas', 'plants'],
    slug: 'macetas-y-jardn'
  },
  {
    regex: /(litho|lito)(f|ph|p)an/i,
    categoryTerms: ['litofanias', 'litofania', 'lithophanie'],
    tagTerms: ['litofanias', 'litofania', 'lithophanie'],
    categoryOverrideEs: 'litofanias',
    slug: 'litofanias'
  },
  {
    regex: /\b(lamp|l[aá]mpar)a?s?\b/i,
    categoryTerms: ['lamparas', 'lampara', 'lamp'],
    tagTerms: ['lamparas', 'lampara', 'lamp'],
    categoryOverrideEs: 'lamparas',
    slug: 'lamparas'
  }
]

/**
 * Aplica las reglas a una lista de slugs existentes.
 * 
 * @param {string} title Título o nombre del archivo
 * @param {string[]} currentSlugs Slugs actuales
 * @returns {string[]} Nueva lista de slugs
 */
export function applyCategorySlugsOverrides(title, currentSlugs = []) {
  const slugs = [...currentSlugs]
  const titleLower = String(title || '').toLowerCase()
  for (const rule of categoryHardOverrideRules) {
    if (rule.slug && rule.regex.test(titleLower)) {
      const normalizedSlug = rule.slug.toLowerCase()
      if (!slugs.some(s => String(s).toLowerCase() === normalizedSlug)) {
        slugs.push(rule.slug)
      }
    }
  }
  return slugs
}

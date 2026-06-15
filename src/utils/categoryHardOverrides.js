/**
 * Definición centralizada de las reglas de anulación estricta (hard overrides)
 * para categorías y tags basados en el nombre o título del archivo.
 */
export const categoryHardOverrideRules = [
  {
    regex: /\b(busto|bust|bustos|busts)\b/i,
    categoryTerms: ['busto', 'bust', 'bustos', 'busts'],
    tagTerms: ['busto', 'bust', 'bustos', 'busts']
  },
  {
    regex: /(flexi|flexible|articulado|articuled|articulated)/i,
    categoryTerms: ['articulados', 'articulado', 'articulated'],
    tagTerms: ['articulado', 'articulated', 'flexible', 'flexi'],
    slug: 'articulated'
  },
  {
    regex: /(keychain|llavero)/i,
    categoryTerms: ['llaveros', 'llavero', 'keychains', 'keychain'],
    tagTerms: ['llavero', 'keychain', 'llaveros', 'keychains'],
    slug: 'llavero'
  },
  {
    regex: /(helmet|mask|armor|casco|mascara|armadura)/i,
    categoryTerms: ['cosplay'],
    tagTerms: ['cosplay', 'casco', 'mascara', 'armadura', 'helmet', 'mask', 'armor']
  },
  {
    regex: /(mug|cup|taza|vaso)/i,
    categoryTerms: ['mugs', 'mug', 'mugs-y-tazas', 'tazas', 'taza', 'vasos', 'vaso'],
    tagTerms: ['mug', 'mugs', 'taza', 'tazas', 'vaso', 'vasos', 'cup', 'cups']
  },
  {
    regex: /(maceta|macetas|planta|plantas|planter|planters|pot|pots|plant|plants)/i,
    categoryTerms: ['macetas', 'pots', 'planters', 'planter'],
    tagTerms: ['macetas', 'pots', 'maceta', 'pot', 'planta', 'plant', 'plantas', 'plants'],
    slug: 'macetas'
  },
  {
    regex: /(litho|lito)(f|ph|p)an/i,
    categoryTerms: ['litofania', 'lithophanie'],
    tagTerms: ['litofania', 'lithophanie'],
    categoryOverrideEs: 'litofanias',
    slug: 'litofania'
  },
  {
    regex: /\b(lamp|l[aá]mpar)a?s?\b/i,
    categoryTerms: ['lampara', 'lamp'],
    tagTerms: ['lampara', 'lamp'],
    categoryOverrideEs: 'lamparas',
    slug: 'lampara'
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

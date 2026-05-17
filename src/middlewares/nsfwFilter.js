import jwt from 'jsonwebtoken'

/**
 * Middleware: intenta leer JWT del header Authorization sin rechazar.
 * - Token válido  → req.user = payload
 * - Sin token / inválido → req.user = null  (NO devuelve 401)
 */
export const optionalAuth = (req, _res, next) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (token) {
      const secret = process.env.JWT_SECRET || 'dev-secret'
      req.user = jwt.verify(token, secret)
    } else {
      req.user = null
    }
  } catch {
    req.user = null
  }
  next()
}

/**
 * Palabras clave que indican contenido NSFW.
 * El filtro hace `contains` parcial contra slug de categorías y tags.
 */
const NSFW_KEYWORDS = ['adult', '18', 'nsfw', 'hentai', 'sexy', 'erotic', 'desnud', 'gore']

/**
 * Construye condiciones Prisma `where` para excluir assets NSFW.
 * - Usuario logueado  → devuelve {} (sin filtro)
 * - Anónimo           → excluye assets cuya categoría o tag contenga alguna keyword
 *
 * Uso: const nsfwWhere = buildNsfwWhere(req);
 *      prisma.asset.findMany({ where: { status: 'PUBLISHED', ...nsfwWhere } })
 */
export function buildNsfwWhere(req) {
  if (req?.user) return {}

  const kwFilters = NSFW_KEYWORDS.map(kw => ({ slug: { contains: kw } }))

  return {
    AND: [
      { categories: { none: { OR: kwFilters } } },
      { tags:       { none: { OR: kwFilters } } },
    ],
  }
}

/**
 * Construye condiciones Prisma para excluir categorías NSFW del listado público.
 * - Usuario logueado  → devuelve {} (sin filtro)
 * - Anónimo           → NOT slug contiene alguna keyword
 */
export function buildNsfwCategoryWhere(req) {
  if (req?.user) return {}

  return {
    NOT: {
      OR: NSFW_KEYWORDS.map(kw => ({ slug: { contains: kw } })),
    },
  }
}

/**
 * Construye condiciones Prisma para excluir tags NSFW del listado público.
 * Misma lógica que categorías pero para la tabla tag.
 */
export function buildNsfwTagWhere(req) {
  if (req?.user) return {}

  return {
    NOT: {
      OR: NSFW_KEYWORDS.map(kw => ({ slug: { contains: kw } })),
    },
  }
}

/**
 * Verifica si un asset (con sus relaciones cargadas) es NSFW.
 * Espera que el asset tenga { categories: [{ slug }], tags: [{ slug }] }
 */
export function isAssetNSFW(asset) {
  if (!asset) return false
  const check = (arr) => {
    if (!Array.isArray(arr)) return false
    return arr.some(item => {
      const s = String(item?.slug || '').toLowerCase()
      return NSFW_KEYWORDS.some(kw => s.includes(kw))
    })
  }
  return check(asset.categories) || check(asset.tags)
}

export { NSFW_KEYWORDS }

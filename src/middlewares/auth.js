import jwt from 'jsonwebtoken'

export const requireAuth = (req, res, next) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token) return res.status(401).json({ message: 'Unauthorized' })

    const secret = process.env.JWT_SECRET || 'dev-secret'
    const payload = jwt.verify(token, secret)
    req.user = payload
    next()
  } catch (e) {
    return res.status(401).json({ message: 'Unauthorized' })
  }
}

export const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' })
  // roleId === 2 => Admin
  if (Number(req.user.roleId) !== 2) return res.status(403).json({ message: 'Forbidden' })
  next()
}

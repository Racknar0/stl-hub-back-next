import { PrismaClient } from '@prisma/client'
import { log } from '../utils/logger.js'

const prisma = new PrismaClient()

// Helpers
function parseIntOrNull(v){ const n = Number(v); return Number.isNaN(n)?null:n }

export const listNotifications = async (req,res) => {
  try {
  const { status, q, take='50', skip='0' } = req.query
  const where = {}
  if (status) where.status = status
  if (q) where.OR = [ { title: { contains: q } }, { body: { contains: q } } ]
    const notifications = await prisma.notification.findMany({
      where,
      orderBy:[ { createdAt:'desc' } ],
      take: Math.min(200, Number(take)||50),
      skip: Number(skip)||0
    })
    res.json({ notifications })
  } catch (e){
    log.error('[NOTIF][LIST] '+e.message)
    res.status(500).json({ message:'Error listando notificaciones' })
  }
}

export const getNotification = async (req,res) => {
  try {
    const id = Number(req.params.id)
    const n = await prisma.notification.findUnique({ where:{ id } })
    if (!n) return res.status(404).json({ message:'No encontrada' })
    res.json(n)
  } catch(e){
    log.error('[NOTIF][GET] '+e.message)
    res.status(500).json({ message:'Error obteniendo notificación' })
  }
}

export const createNotification = async (req,res) => {
  try {
  const { title, body, status='UNREAD' } = req.body || {}
  if (!title) return res.status(400).json({ message:'title requerido' })
  if (!['UNREAD','READ'].includes(status)) return res.status(400).json({ message:'status inválido' })
  const data = { title, body: body||null, status }
    const n = await prisma.notification.create({ data })
    log.info('[NOTIF][CREATE] id='+n.id)
    res.status(201).json(n)
  } catch(e){
    log.error('[NOTIF][CREATE] '+e.message)
    res.status(500).json({ message:'Error creando notificación' })
  }
}

export const updateNotification = async (req,res) => {
  try {
    const id = Number(req.params.id)
  const { title, body, status } = req.body || {}
    const data = {}
    if (title!==undefined) data.title = title
    if (body!==undefined) data.body = body
    if (status!==undefined){
      if (!['UNREAD','READ'].includes(status)) return res.status(400).json({ message:'status inválido' })
      data.status = status
    }
    // authorId eliminado, ya no existe en el modelo
    const n = await prisma.notification.update({ where:{ id }, data })
    log.info('[NOTIF][UPDATE] id='+id)
    res.json(n)
  } catch(e){
    log.error('[NOTIF][UPDATE] '+e.message)
    if (e.code === 'P2025') return res.status(404).json({ message:'No encontrada' })
    res.status(500).json({ message:'Error actualizando notificación' })
  }
}

export const deleteNotification = async (req,res) => {
  try {
    const id = Number(req.params.id)
    await prisma.notification.delete({ where:{ id } })
    log.info('[NOTIF][DELETE] id='+id)
    res.json({ ok:true })
  } catch(e){
    log.error('[NOTIF][DELETE] '+e.message)
    if (e.code === 'P2025') return res.status(404).json({ message:'No encontrada' })
    res.status(500).json({ message:'Error eliminando notificación' })
  }
}

export const markAllNotificationsRead = async (req,res) => {
  try {
    const result = await prisma.notification.updateMany({ where:{ status:'UNREAD' }, data:{ status:'READ' } })
    log.info(`[NOTIF][MARK_ALL_READ] count=${result.count}`)
    res.json({ ok:true, updated: result.count })
  } catch (e){
    log.error('[NOTIF][MARK_ALL_READ] '+e.message)
    res.status(500).json({ message:'Error marcando notificaciones' })
  }
}

// Eliminar todas las notificaciones de tipo AUTOMATION
export const clearAutomationNotifications = async (req,res) => {
  try {
    const result = await prisma.notification.deleteMany({ where: { type: 'AUTOMATION' } })
    log.info(`[NOTIF][CLEAR_AUTOMATION] deleted=${result.count}`)
    res.json({ ok: true, deleted: result.count })
  } catch (e) {
    log.error('[NOTIF][CLEAR_AUTOMATION] '+e.message)
    res.status(500).json({ message: 'Error limpiando notificaciones de automatizaciones' })
  }
}

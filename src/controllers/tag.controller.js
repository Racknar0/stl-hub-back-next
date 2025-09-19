import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export async function listTags(req, res) {
  try {
    const items = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}

export async function getTag(req, res) {
  const id = Number(req.params.id);
  try {
    const item = await prisma.tag.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}

export async function createTag(req, res) {
  const { name, slug } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'NAME_AND_SLUG_REQUIRED' });
  try {
    const item = await prisma.tag.create({ data: { name, slug } });
    res.status(201).json(item);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'CREATE_FAILED', detail: e.message });
  }
}

export async function updateTag(req, res) {
  const id = Number(req.params.id);
  const { name, slug } = req.body || {};
  try {
    const item = await prisma.tag.update({ where: { id }, data: { name, slug } });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'UPDATE_FAILED', detail: e.message });
  }
}

export async function deleteTag(req, res) {
  const id = Number(req.params.id);
  try {
    await prisma.tag.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'DELETE_FAILED', detail: e.message });
  }
}

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export async function listCategories(req, res) {
  try {
    const items = await prisma.category.findMany({ orderBy: { name: 'asc' } });
    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}

export async function getCategory(req, res) {
  const id = Number(req.params.id);
  try {
    const item = await prisma.category.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}

export async function createCategory(req, res) {
  const { name, slug, description, nameEn, slugEn } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'NAME_AND_SLUG_REQUIRED' });
  try {
    const item = await prisma.category.create({ data: { name, slug, description, nameEn, slugEn } });
    res.status(201).json(item);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'CREATE_FAILED', detail: e.message });
  }
}

export async function updateCategory(req, res) {
  const id = Number(req.params.id);
  const { name, slug, description, nameEn, slugEn } = req.body || {};
  try {
    const item = await prisma.category.update({ where: { id }, data: { name, slug, description, nameEn, slugEn } });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'UPDATE_FAILED', detail: e.message });
  }
}

export async function deleteCategory(req, res) {
  const id = Number(req.params.id);
  try {
    await prisma.category.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'DELETE_FAILED', detail: e.message });
  }
}

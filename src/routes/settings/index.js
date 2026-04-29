import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { PrismaClient } from '@prisma/client';

const router = express.Router();
const prisma = new PrismaClient();

// Get all system settings
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const settings = await prisma.systemSetting.findMany();
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Upsert a system setting
router.put('/:key', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value, description } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }

    const setting = await prisma.systemSetting.upsert({
      where: { key },
      update: { 
        value: String(value),
        ...(description !== undefined && { description: String(description) })
      },
      create: { 
        key, 
        value: String(value),
        description: description ? String(description) : null
      },
    });

    res.json(setting);
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;

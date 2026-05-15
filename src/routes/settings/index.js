import express from 'express';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import { PrismaClient } from '@prisma/client';
import { getPlans } from '../../config/plans.js';

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


// Get computed plans for public display (no auth required)
router.get('/public/plans', async (req, res) => {
  try {
    const plans = await getPlans();

    // Build the public-facing plan array with computed monthly/save values
    const planDefs = [
      { id: '1m', days: 30, tag: null, highlight: false },
      { id: '3m', days: 90, tag: null, highlight: false },
      { id: '6m', days: 180, tag: 'recommended', highlight: true },
      { id: '12m', days: 365, tag: 'bestValue', highlight: false },
    ];

    const baseMonthly = Number(plans['1m']?.price || 5);

    const result = planDefs.map((def) => {
      const plan = plans[def.id];
      if (!plan) return null;
      const total = Number(plan.price);
      const months = def.days / 30;
      const monthly = Number((total / months).toFixed(2));
      const fullPrice = baseMonthly * months;
      const saved = Number((fullPrice - total).toFixed(2));

      return {
        id: def.id,
        name: String(def.days),
        monthly,
        total,
        save: saved > 0 ? { amount: `$${Math.round(saved)}` } : null,
        tag: def.tag,
        highlight: def.highlight,
      };
    }).filter(Boolean);

    // Fetch total assets for the glow effect
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const totalAssets = await prisma.asset.count();

    res.json({ success: true, plans: result, totalAssets });
  } catch (error) {
    console.error('Error fetching public plans:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;

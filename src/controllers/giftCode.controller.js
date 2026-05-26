import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ─── Helpers ────────────────────────────────────────────
const generateCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion
  let code = 'STL-';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
};

// ─── ADMIN: Create gift code ────────────────────────────
export const createGiftCode = async (req, res) => {
  try {
    const { code, days, maxUses, expiresAt, note } = req.body;

    if (!days || Number(days) <= 0) {
      return res.status(400).json({ message: 'days must be a positive number' });
    }

    // Use provided code or auto-generate
    let finalCode = code ? String(code).trim().toUpperCase() : generateCode();

    // Ensure uniqueness for auto-generated codes
    if (!code) {
      let attempts = 0;
      while (attempts < 10) {
        const exists = await prisma.giftCode.findUnique({ where: { code: finalCode } });
        if (!exists) break;
        finalCode = generateCode();
        attempts++;
      }
    }

    // Check for duplicates if manual code
    if (code) {
      const existing = await prisma.giftCode.findUnique({ where: { code: finalCode } });
      if (existing) {
        return res.status(409).json({ message: `Code "${finalCode}" already exists` });
      }
    }

    const giftCode = await prisma.giftCode.create({
      data: {
        code: finalCode,
        days: Number(days),
        maxUses: Number(maxUses) || 1,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        note: note || null,
      },
    });

    return res.status(201).json(giftCode);
  } catch (e) {
    console.error('[GIFT-CODES] create error:', e);
    return res.status(500).json({ message: 'Error creating gift code' });
  }
};

// ─── ADMIN: List all gift codes ─────────────────────────
export const listGiftCodes = async (req, res) => {
  try {
    const codes = await prisma.giftCode.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        redemptions: {
          select: {
            id: true,
            userId: true,
            daysGiven: true,
            redeemedAt: true,
            user: { select: { email: true } },
          },
          orderBy: { redeemedAt: 'desc' },
        },
      },
    });
    return res.json({ items: codes });
  } catch (e) {
    console.error('[GIFT-CODES] list error:', e);
    return res.status(500).json({ message: 'Error listing gift codes' });
  }
};

// ─── ADMIN: Update gift code ────────────────────────────
export const updateGiftCode = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, days, maxUses, expiresAt, note, isActive } = req.body;

    const updates = {};
    if (code !== undefined) updates.code = String(code).trim().toUpperCase();
    if (days !== undefined) updates.days = Number(days);
    if (maxUses !== undefined) updates.maxUses = Number(maxUses);
    if (expiresAt !== undefined) updates.expiresAt = expiresAt ? new Date(expiresAt) : null;
    if (note !== undefined) updates.note = note || null;
    if (isActive !== undefined) updates.isActive = Boolean(isActive);

    const updated = await prisma.giftCode.update({
      where: { id: Number(id) },
      data: updates,
    });

    return res.json(updated);
  } catch (e) {
    console.error('[GIFT-CODES] update error:', e);
    return res.status(500).json({ message: 'Error updating gift code' });
  }
};

// ─── ADMIN: Delete gift code ────────────────────────────
export const deleteGiftCode = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.giftCode.delete({ where: { id: Number(id) } });
    return res.json({ message: 'Deleted' });
  } catch (e) {
    console.error('[GIFT-CODES] delete error:', e);
    return res.status(500).json({ message: 'Error deleting gift code' });
  }
};

// ─── PUBLIC: Validate a gift code (no auth required) ────
export const validateGiftCode = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.json({ valid: false, message: 'No code provided' });

    const gc = await prisma.giftCode.findUnique({
      where: { code: String(code).trim().toUpperCase() },
    });

    if (!gc) return res.json({ valid: false, message: 'Code not found' });
    if (!gc.isActive) return res.json({ valid: false, message: 'Code is inactive' });
    if (gc.expiresAt && new Date() > gc.expiresAt) return res.json({ valid: false, message: 'Code has expired' });
    if (gc.usedCount >= gc.maxUses) return res.json({ valid: false, message: 'Code has reached max uses' });

    return res.json({ valid: true, days: gc.days });
  } catch (e) {
    console.error('[GIFT-CODES] validate error:', e);
    return res.json({ valid: false, message: 'Validation error' });
  }
};

// ─── AUTH: Redeem a gift code ───────────────────────────
export const redeemGiftCode = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { code } = req.body;

    if (!code) return res.status(400).json({ message: 'Code is required' });

    const gc = await prisma.giftCode.findUnique({
      where: { code: String(code).trim().toUpperCase() },
    });

    if (!gc) return res.status(404).json({ message: 'Code not found' });
    if (!gc.isActive) return res.status(400).json({ message: 'Code is inactive' });
    if (gc.expiresAt && new Date() > gc.expiresAt) return res.status(400).json({ message: 'Code has expired' });
    if (gc.usedCount >= gc.maxUses) return res.status(400).json({ message: 'Code has reached max uses' });

    // Check if user already redeemed
    const existing = await prisma.giftRedemption.findUnique({
      where: { codeId_userId: { codeId: gc.id, userId } },
    });
    if (existing) return res.status(400).json({ message: 'You have already redeemed this code' });

    // Create or extend subscription
    const now = new Date();
    const userSubscription = await prisma.subscription.findFirst({
      where: { userId },
      orderBy: { currentPeriodEnd: 'desc' },
    });

    const startDate = userSubscription && userSubscription.status === 'ACTIVE' && userSubscription.currentPeriodEnd > now
      ? userSubscription.currentPeriodEnd
      : now;

    const newExpiryDate = new Date(startDate);
    newExpiryDate.setDate(newExpiryDate.getDate() + gc.days);

    await prisma.subscription.upsert({
      where: { id: userSubscription?.id || 0 },
      update: {
        currentPeriodEnd: newExpiryDate,
        status: 'ACTIVE',
      },
      create: {
        userId,
        currentPeriodEnd: newExpiryDate,
        status: 'ACTIVE',
      },
    });

    // Record redemption and increment counter
    await prisma.$transaction([
      prisma.giftRedemption.create({
        data: { codeId: gc.id, userId, daysGiven: gc.days },
      }),
      prisma.giftCode.update({
        where: { id: gc.id },
        data: { usedCount: { increment: 1 } },
      }),
    ]);

    return res.json({
      message: 'Code redeemed successfully',
      daysGranted: gc.days,
    });
  } catch (e) {
    console.error('[GIFT-CODES] redeem error:', e);
    return res.status(500).json({ message: 'Error redeeming code' });
  }
};

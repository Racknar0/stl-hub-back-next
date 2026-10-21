import { transporter } from '../controllers/nodeMailerController.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Avisa de un problema con un reel: notificación en la campana del dashboard y,
 * si SELLER_EMAIL está configurado, un correo al administrador (igual que Pinterest).
 *
 * @param {Object} params
 * @param {Object} params.post - El reel (id, assetId, assetTitle, scheduledAt…).
 * @param {string} params.title - Asunto corto del aviso.
 * @param {string} params.detail - Qué pasó y qué hacer.
 * @param {'ERROR'|'WARNING'} [params.level] - Gravedad (por defecto ERROR).
 * @param {Array<{label: string, url: string}>} [params.links] - Enlaces útiles (publicaciones, asset…).
 */
export const dispatchReelNotification = async ({ post, title, detail, level = 'ERROR', links = [] } = {}) => {
  const reelLabel = `Reel #${post?.id ?? '?'}${post?.assetId ? ` (asset #${post.assetId}${post.assetTitle ? ` · ${post.assetTitle}` : ''})` : ''}`;
  const when = post?.scheduledAt ? new Date(post.scheduledAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : 'sin día';
  const linkLines = links.filter(l => l?.url).map(l => `${l.label}: ${l.url}`);

  // 1. Notificación interna (campana del dashboard)
  try {
    await prisma.notification.create({
      data: {
        title: `${title} · ${reelLabel}`,
        body: [detail, '', `Programado: ${when}`, ...linkLines].join('\n'),
        status: 'UNREAD',
        type: 'SOCIAL',
        typeStatus: level,
      },
    });
  } catch (e) {
    console.error('[REELS][NOTIFICATION] No se pudo crear la notificación interna:', e.message);
  }

  // 2. Correo al administrador
  const sellerEmail = String(process.env.SELLER_EMAIL || '').trim();
  if (!sellerEmail) return;
  try {
    const icon = level === 'ERROR' ? '❌' : '⚠️';
    await transporter.sendMail({
      from: process.env.SMTP_EMAIL,
      to: sellerEmail,
      subject: `${icon} Reels: ${title} (${reelLabel})`,
      text: [`Aviso del Reels Publisher`, '', reelLabel, `Programado: ${when}`, '', detail, '', ...linkLines, '', 'Revisa el reel en Dashboard → Upload → Reels Publisher.'].join('\n'),
      html: `
        <!doctype html>
        <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
        <body style="margin:0;padding:0;background:#f6f7f9;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
            <tr><td align="center">
              <table role="presentation" width="100%" style="max-width:600px;">
                <tr><td style="background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;line-height:1.55;">
                  <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:${level === 'ERROR' ? '#dc2626' : '#d97706'};">${icon} ${escapeHtml(title)}</h1>
                  <p style="margin:0 0 18px;font-size:14px;color:#64748b;">${escapeHtml(reelLabel)} · programado: ${escapeHtml(when)}</p>
                  <div style="background:${level === 'ERROR' ? '#fef2f2' : '#fffbeb'};border:1px solid ${level === 'ERROR' ? '#fee2e2' : '#fde68a'};border-radius:6px;padding:12px;margin-bottom:18px;color:#0f172a;font-size:14px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(detail)}</div>
                  ${links.filter(l => l?.url).map(l => `<p style="margin:0 0 6px;font-size:14px;"><strong>${escapeHtml(l.label)}:</strong> <a href="${escapeHtml(l.url)}" style="color:#4f46e5;">${escapeHtml(l.url)}</a></p>`).join('')}
                  <hr style="border:none;border-top:1px solid #e6e8eb;margin:22px 0;">
                  <p style="margin:0;font-size:12px;color:#64748b;">Notificación automática del Reels Publisher de STL Hub. Revisa el reel en Dashboard → Upload → Reels Publisher.</p>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </body></html>`.trim(),
    });
  } catch (e) {
    console.error('[REELS][NOTIFICATION] No se pudo enviar el correo:', e.message);
  }
};

export default { dispatchReelNotification };

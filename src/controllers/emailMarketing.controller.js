// Endpoints del módulo Marketing (correo) del dashboard.
// Ojo: marketing.controller.js es otra cosa (campañas UTM de adquisición).

import { PrismaClient } from '@prisma/client';
import svc from '../services/emailMarketing.service.js';
import brevo from '../services/brevo.service.js';
import engine from '../services/emailEngine.service.js';
import reengage from '../services/emailReengage.service.js';

const prisma = new PrismaClient();

// Definición del embudo de bienvenida. Hoy corre dentro de Brevo;
// aquí se declara para poder pintarlo y medirlo desde el panel.
export const WELCOME_FLOW = [
  { kind: 'WELCOME_1', delayDays: 0, delayLabel: '1 h', templateId: 15, name: 'Bienvenida' },
  { kind: 'WELCOME_2', delayDays: 3, delayLabel: 'día 3', templateId: 16, name: 'Premium' },
  { kind: 'WELCOME_3', delayDays: 7, delayLabel: 'día 7', templateId: 17, name: 'Top descargas' },
  { kind: 'WELCOME_4', delayDays: 12, delayLabel: 'día 12', templateId: 18, name: 'Planes' },
];

const fail = (res, e, msg) => {
  console.error(`[email-marketing] ${msg}:`, e);
  return res.status(500).json({ error: msg, detail: e?.message || null });
};

/** GET /overview — métricas de la pantalla Resumen. */
export const getOverview = async (_req, res) => {
  try {
    const data = await svc.getOverview();
    return res.json(data);
  } catch (e) {
    return fail(res, e, 'No se pudo calcular el resumen');
  }
};

/** GET /audiences — conteos por etapa. */
export const getAudiences = async (_req, res) => {
  try {
    const data = await svc.getAudienceCounts();
    return res.json(data);
  } catch (e) {
    return fail(res, e, 'No se pudieron calcular las audiencias');
  }
};

/** GET /audiences/:stage — listado paginado (NEW | ACTIVE | DORMANT | OPTED_OUT | ALL). */
export const listAudience = async (req, res) => {
  try {
    const stage = String(req.params.stage || 'ALL').toUpperCase();
    if (stage !== 'ALL' && !svc.STAGES.includes(stage)) {
      return res.status(400).json({ error: 'Etapa no válida', stages: svc.STAGES });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

    const data = await svc.listAudience(stage, { page, pageSize });
    return res.json(data);
  } catch (e) {
    return fail(res, e, 'No se pudo listar la audiencia');
  }
};

/** GET /flows — embudo de bienvenida con sus contadores. */
export const getFlows = async (_req, res) => {
  try {
    const grouped = await prisma.emailLog.groupBy({
      by: ['kind', 'status'],
      _count: { _all: true },
    });
    const countOf = (kind, status) =>
      grouped.find((g) => g.kind === kind && g.status === status)?._count._all || 0;
    const sentByKind = new Map(WELCOME_FLOW.map((s) => [s.kind, countOf(s.kind, 'SENT')]));

    const logs = await prisma.emailLog.findMany({
      where: { kind: { in: WELCOME_FLOW.map((s) => s.kind) }, status: 'SENT' },
      select: { kind: true, openedAt: true, clickedAt: true },
    });

    const steps = WELCOME_FLOW.map((step) => {
      const own = logs.filter((l) => l.kind === step.kind);
      return {
        ...step,
        sent: sentByKind.get(step.kind) || 0,
        queued: countOf(step.kind, 'QUEUED'),
        opened: own.filter((l) => l.openedAt).length,
        clicked: own.filter((l) => l.clickedAt).length,
      };
    });

    return res.json({
      name: 'Bienvenida a nuevos registros',
      // El embudo vive en Brevo; el backend solo mide lo que pasa por él.
      runsOn: 'brevo',
      steps,
    });
  } catch (e) {
    return fail(res, e, 'No se pudo cargar el embudo');
  }
};

/** GET /templates — plantillas desde Brevo. */
export const listTemplates = async (_req, res) => {
  try {
    if (!brevo.isConfigured()) {
      return res.status(503).json({ error: 'BREVO_API_KEY no configurada', items: [] });
    }
    const data = await brevo.listTemplates({ limit: 50 });
    return res.json(data);
  } catch (e) {
    return fail(res, e, 'No se pudieron leer las plantillas de Brevo');
  }
};

/** GET /logs — últimos envíos registrados. */
export const listLogs = async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, Number(req.query.take) || 50));
    const items = await prisma.emailLog.findMany({
      take,
      where: { status: 'SENT' },
      orderBy: { sentAt: 'desc' },
      include: {
        contact: { select: { userId: true, user: { select: { email: true } } } },
      },
    });

    return res.json({
      items: items.map((l) => ({
        id: l.id,
        kind: l.kind,
        subject: l.subject,
        email: l.contact?.user?.email || null,
        sentAt: l.sentAt,
        deliveredAt: l.deliveredAt,
        openedAt: l.openedAt,
        clickedAt: l.clickedAt,
        bouncedAt: l.bouncedAt,
      })),
    });
  } catch (e) {
    return fail(res, e, 'No se pudieron leer los envíos');
  }
};

/** POST /sync — recalcula las etapas y las guarda. */
export const syncStages = async (_req, res) => {
  try {
    const result = await svc.syncStages();
    return res.json(result);
  } catch (e) {
    return fail(res, e, 'No se pudieron recalcular las etapas');
  }
};

/** POST /contacts/:userId/opt-out */
export const optOutContact = async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId no válido' });

    const reason = String(req.body?.reason || 'MANUAL').toUpperCase();
    const contact = await svc.optOut(userId, reason);
    return res.json(contact);
  } catch (e) {
    return fail(res, e, 'No se pudo dar de baja el contacto');
  }
};

/** POST /contacts/:userId/opt-in */
export const optInContact = async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId no válido' });

    const contact = await svc.optIn(userId);
    return res.json(contact);
  } catch (e) {
    return fail(res, e, 'No se pudo reactivar el contacto');
  }
};

const engineState = async () => {
  const [config, queue, failedLogs] = await Promise.all([
    engine.loadConfig(),
    engine.getQueueSummary(),
    prisma.emailLog.findMany({
      where: { status: 'FAILED' },
      orderBy: { scheduledFor: 'desc' },
      take: 10,
      select: {
        id: true,
        kind: true,
        attempts: true,
        lastError: true,
        scheduledFor: true,
        contact: { select: { user: { select: { email: true } } } },
      },
    }),
  ]);
  return {
    failures: failedLogs.map((l) => ({
      id: l.id,
      kind: l.kind,
      attempts: l.attempts,
      error: l.lastError,
      scheduledFor: l.scheduledFor,
      email: l.contact?.user?.email || null,
    })),
    enabled: config.enabled,
    start: config.start,
    dailyLimit: config.dailyLimit,
    dailyReserve: config.dailyReserve,
    queue: { queued: queue.queued, failed: queue.failed, nextAt: queue.nextAt },
    ready: {
      secret: Boolean(process.env.EMAIL_UNSUBSCRIBE_SECRET),
      brevo: brevo.isConfigured(),
    },
  };
};

/** GET /engine — ajustes y estado del motor de envíos. */
export const getEngine = async (_req, res) => {
  try {
    return res.json(await engineState());
  } catch (e) {
    return fail(res, e, 'No se pudo leer el motor de envíos');
  }
};

/** PUT /engine — cambia interruptor, fecha de corte, límite o reserva. */
export const updateEngine = async (req, res) => {
  try {
    const current = await engine.loadConfig();
    const { values, error } = engine.parseEngineSettings(req.body || {}, {
      current,
      hasSecret: Boolean(process.env.EMAIL_UNSUBSCRIBE_SECRET),
    });
    if (error) return res.status(400).json({ error });

    for (const [key, value] of Object.entries(values)) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value, description: 'Motor de correos (panel Marketing)' },
      });
    }
    return res.json(await engineState());
  } catch (e) {
    return fail(res, e, 'No se pudo guardar el motor de envíos');
  }
};

/** POST /engine/test — envía un paso del embudo al correo del admin que lo pide. */
export const sendEngineTest = async (req, res) => {
  try {
    const out = await engine.sendTestEmail({ kind: String(req.body?.kind || ''), userId: req.user.id });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json(out);
  } catch (e) {
    return fail(res, e, 'No se pudo enviar la prueba');
  }
};

/** GET /reengage — estado del reenganche de dormidos. */
export const getReengage = async (_req, res) => {
  try {
    return res.json(await reengage.getReengageSummary());
  } catch (e) {
    return fail(res, e, 'No se pudo leer el reenganche');
  }
};

/** POST /reengage/launch — pone en cola una tanda ({ batchSize }). */
export const launchReengage = async (req, res) => {
  try {
    const out = await reengage.launchReengageBatch({ batchSize: req.body?.batchSize });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json(out);
  } catch (e) {
    return fail(res, e, 'No se pudo lanzar la tanda');
  }
};

export default {
  getReengage,
  launchReengage,
  sendEngineTest,
  getEngine,
  updateEngine,
  getOverview,
  getAudiences,
  listAudience,
  getFlows,
  listTemplates,
  listLogs,
  syncStages,
  optOutContact,
  optInContact,
};

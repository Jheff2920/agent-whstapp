import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LEAD_STAGES } from "../agent/tools.js";
import type { Config } from "../config.js";
import type { AppointmentService } from "../appointments/service.js";
import { addDays, localHm, localYmd, zonedToUtc } from "../appointments/time.js";
import type { ConversationRow, Mode, Repo } from "../db/repos.js";
import type { EventBus } from "../events.js";
import type { Outbox } from "../outbox.js";
import type { Auth } from "./auth.js";

export interface PanelDeps {
  cfg: Config;
  repo: Repo;
  outbox: Outbox;
  bus: EventBus;
  auth: Auth;
  /** Citas en tienda (opcional: sin él no hay agenda). */
  appointments?: AppointmentService;
  /** Datos informativos para la pantalla de estado. */
  info: { provider: string; model: string; sendConfigured: boolean; alertChannel: "telegram" | "n8n" | "none"; knowledgePending: () => string[] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function windowOf(lastCustomerAt: string | null, now = Date.now()) {
  if (!lastCustomerAt) return { open: false, closesAt: null as string | null };
  const closes = new Date(lastCustomerAt).getTime() + DAY_MS;
  return { open: closes > now, closesAt: new Date(closes).toISOString() };
}

const listItem = (r: ConversationRow) => ({
  id: r.id,
  mode: r.mode,
  unread: r.unread,
  customer: { id: r.customer_id, name: r.name, waId: r.wa_id, stage: r.stage, optedOut: r.opted_out === 1 },
  lastBody: r.last_body,
  lastAuthor: r.last_author,
  lastMessageAt: r.last_message_at,
  window: windowOf(r.last_customer_message_at),
});

const idParam = z.coerce.number().int().positive();
const MODES: Mode[] = ["bot", "humano", "escalado"];

export function registerPanelApi(app: FastifyInstance, d: PanelDeps): void {
  const { repo, auth, bus, outbox } = d;

  // ---- autenticación y protección básica contra CSRF ----
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin) {
        let host = "";
        try {
          host = new URL(origin).host;
        } catch {
          // un Origin ilegible ("null", etc.) se trata como no permitido
        }
        if (host !== req.headers.host) return reply.code(403).send({ error: "origen no permitido" });
      }
    }
    const open = req.url === "/api/auth/login" || req.url === "/api/auth/me";
    if (!open && !auth.isAuthenticated(req.headers.cookie)) {
      return reply.code(401).send({ error: "no autenticado" });
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (!auth.configured) return reply.code(503).send({ error: "El panel no tiene contraseña configurada (ADMIN_PASSWORD)" });
    const ip = req.ip;
    if (!auth.allowAttempt(ip)) return reply.code(429).send({ error: "Demasiados intentos; espera unos minutos" });
    const body = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success || !auth.checkPassword(body.data.password)) {
      auth.recordFailure(ip);
      return reply.code(401).send({ error: "Contraseña incorrecta" });
    }
    auth.clearFailures(ip);
    reply.header("set-cookie", auth.issueCookie());
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.header("set-cookie", auth.clearCookie());
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ authenticated: auth.isAuthenticated(req.headers.cookie), configured: auth.configured }));

  // ---- conversaciones ----
  app.get("/api/conversations", async (req, reply) => {
    const parsed = z
      .object({ filter: z.enum(["todas", "bot", "humano", "escalado", "sin_leer"]).default("todas"), q: z.string().max(100).optional() })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "filtro inválido" });
    const q = parsed.data;
    const rows = repo.listConversations({
      mode: MODES.includes(q.filter as Mode) ? (q.filter as Mode) : undefined,
      unreadOnly: q.filter === "sin_leer",
      q: q.q,
    });
    return { conversations: rows.map(listItem) };
  });

  const detail = (id: number) => {
    const conv = repo.getConversation(id);
    if (!conv) return undefined;
    const customer = repo.getCustomer(conv.customer_id)!;
    return {
      conversation: { id: conv.id, mode: conv.mode, unread: conv.unread, window: windowOf(conv.last_customer_message_at) },
      customer: {
        id: customer.id,
        name: customer.name,
        waId: customer.wa_id,
        stage: customer.stage,
        summary: customer.summary,
        optedOut: customer.opted_out === 1,
        createdAt: customer.created_at,
        facts: repo.getFacts(customer.id),
        appointments: appts?.enabled ? appts.customerUpcoming(customer.id).map((a) => ({ id: a.id, text: appts.describe(a), contactName: a.contact_name })) : [],
      },
      messages: repo.allMessages(id).map((m) => ({
        id: m.id,
        direction: m.direction,
        author: m.author,
        body: m.body,
        status: m.status,
        createdAt: m.created_at,
      })),
    };
  };

  const withConversation = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = idParam.safeParse((req.params as { id: string }).id);
    if (!id.success || !repo.getConversation(id.data)) {
      reply.code(404).send({ error: "conversación no encontrada" });
      return undefined;
    }
    return id.data;
  };

  app.get("/api/conversations/:id", async (req, reply) => {
    const id = await withConversation(req, reply);
    if (id === undefined) return;
    if (repo.getConversation(id)!.unread > 0) {
      repo.markRead(id);
      bus.emit({ type: "conversation", conversationId: id });
    }
    return detail(id);
  });

  const setMode = (id: number, mode: Mode, note: string) => {
    repo.setMode(id, mode);
    repo.addMessage({ conversationId: id, direction: "out", author: "nota", body: note, status: "internal" });
    bus.emit({ type: "conversation", conversationId: id });
  };

  app.post("/api/conversations/:id/takeover", async (req, reply) => {
    const id = await withConversation(req, reply);
    if (id === undefined) return;
    setMode(id, "humano", "Un asesor tomó el control de la conversación");
    return detail(id);
  });

  app.post("/api/conversations/:id/release", async (req, reply) => {
    const id = await withConversation(req, reply);
    if (id === undefined) return;
    setMode(id, "bot", "El asistente retomó la conversación");
    return detail(id);
  });

  app.post("/api/conversations/:id/send", async (req, reply) => {
    const id = await withConversation(req, reply);
    if (id === undefined) return;
    const body = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "El mensaje no puede estar vacío (máximo 4000 caracteres)" });

    const conv = repo.getConversation(id)!;
    const customer = repo.getCustomer(conv.customer_id)!;
    if (customer.opted_out) {
      return reply.code(409).send({ error: "El cliente pidió no recibir más mensajes", code: "opted_out" });
    }
    if (!windowOf(conv.last_customer_message_at).open) {
      return reply.code(409).send({
        error: "Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas",
        code: "window_closed",
      });
    }
    // Si el bot seguía activo, la persona toma el control para que no hablen los dos a la vez.
    if (conv.mode === "bot") setMode(id, "humano", "Un asesor tomó el control al escribir");
    outbox.enqueue({ conversationId: id, toWaId: customer.wa_id, body: body.data.text, author: "humano" });
    bus.emit({ type: "message", conversationId: id });
    return detail(id);
  });

  app.post("/api/conversations/:id/notes", async (req, reply) => {
    const id = await withConversation(req, reply);
    if (id === undefined) return;
    const body = z.object({ text: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "La nota no puede estar vacía" });
    repo.addMessage({ conversationId: id, direction: "out", author: "nota", body: body.data.text, status: "internal" });
    bus.emit({ type: "message", conversationId: id });
    return detail(id);
  });

  // ---- ficha del cliente ----
  app.patch("/api/customers/:id", async (req, reply) => {
    const id = idParam.safeParse((req.params as { id: string }).id);
    if (!id.success || !repo.getCustomer(id.data)) return reply.code(404).send({ error: "cliente no encontrado" });
    const body = z
      .object({
        name: z.string().trim().max(120).nullable().optional(),
        stage: z.enum(LEAD_STAGES).optional(),
        summary: z.string().trim().max(2000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "datos inválidos" });
    repo.updateCustomer(id.data, body.data);
    const conv = repo.getOrCreateConversation(id.data);
    bus.emit({ type: "conversation", conversationId: conv.id });
    return detail(conv.id);
  });

  app.put("/api/customers/:id/facts", async (req, reply) => {
    const id = idParam.safeParse((req.params as { id: string }).id);
    if (!id.success || !repo.getCustomer(id.data)) return reply.code(404).send({ error: "cliente no encontrado" });
    const body = z.object({ key: z.string().trim().min(2).max(40), value: z.string().trim().min(1).max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "datos inválidos" });
    repo.setFact(id.data, body.data.key.toLowerCase().replace(/\s+/g, "_"), body.data.value);
    return detail(repo.getOrCreateConversation(id.data).id);
  });

  app.delete("/api/customers/:id/facts/:key", async (req, reply) => {
    const params = req.params as { id: string; key: string };
    const id = idParam.safeParse(params.id);
    if (!id.success || !repo.getCustomer(id.data)) return reply.code(404).send({ error: "cliente no encontrado" });
    repo.deleteFact(id.data, params.key);
    return detail(repo.getOrCreateConversation(id.data).id);
  });

  // ---- agenda de citas ----
  const appts = d.appointments;
  const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const hm = z.string().regex(/^\d{2}:\d{2}$/);
  const agendaOff = (reply: FastifyReply) => reply.code(404).send({ error: "Las citas no están activadas (falta `citas` en knowledge/sedes.yml)" });
  const sedesInfo = () => (appts?.sedes() ?? []).map((x) => ({ id: x.id, nombre: x.nombre, googleCalendar: Boolean(x.calendar_id) }));

  const apptItem = (a: ReturnType<Repo["listAppointments"]>[number]) => {
    const tz = d.cfg.timezone;
    const start = new Date(a.starts_at);
    return {
      id: a.id,
      sede: a.sede,
      date: localYmd(start, tz),
      time: localHm(start, tz),
      endTime: localHm(new Date(a.ends_at), tz),
      startsAt: a.starts_at,
      contactName: a.contact_name,
      purpose: a.purpose,
      status: a.status,
      source: a.source,
      google: { sync: a.google_sync, error: a.google_error },
      customer: { id: a.customer_id, name: a.customer_name, waId: a.wa_id },
      conversationId: a.conversation_id,
    };
  };

  app.get("/api/agenda", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const q = z.object({ from: ymd.optional(), to: ymd.optional(), sede: z.string().max(40).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "rango inválido" });
    const tz = d.cfg.timezone;
    const from = q.data.from ?? localYmd(new Date(), tz);
    const to = q.data.to ?? addDays(from, 6);
    if (to < from || to > addDays(from, 92)) return reply.code(400).send({ error: "El rango debe ser de 1 a 92 días" });
    const rows = repo.listAppointments(zonedToUtc(from, "00:00", tz).toISOString(), zonedToUtc(addDays(to, 1), "00:00", tz).toISOString(), q.data.sede);
    return { from, to, sedes: sedesInfo(), appointments: rows.map(apptItem) };
  });

  app.get("/api/agenda/slots", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const q = z.object({ sede: z.string().min(1).max(40), fecha: ymd, excluir: z.coerce.number().int().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "parámetros inválidos" });
    return { hours: appts.freeHours(q.data.sede, q.data.fecha, q.data.excluir) };
  });

  const reply409 = (reply: FastifyReply, r: { code: string; text: string }) => reply.code(409).send({ error: r.text, code: r.code });
  const apptById = (req: FastifyRequest) => {
    const id = idParam.safeParse((req.params as { id: string }).id);
    return id.success ? repo.getAppointment(id.data) : undefined;
  };
  const one = (id: number) => {
    const a = repo.getAppointment(id)!;
    const customer = repo.getCustomer(a.customer_id)!;
    return apptItem({ ...a, wa_id: customer.wa_id, customer_name: customer.name });
  };

  app.post("/api/agenda", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const body = z
      .object({
        phone: z.string().min(6).max(25),
        sede: z.string().min(1).max(40),
        fecha: ymd,
        hora: hm,
        nombre: z.string().trim().min(2).max(80),
        motivo: z.string().trim().max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "datos inválidos" });
    let waId = body.data.phone.replace(/\D/g, "");
    if (/^9\d{8}$/.test(waId)) waId = `51${waId}`; // celular peruano sin prefijo
    if (waId.length < 8 || waId.length > 15) return reply.code(400).send({ error: "Teléfono inválido (usa el formato internacional, p. ej. 51987654321)" });
    const customer = repo.upsertCustomer(waId, body.data.nombre);
    const conv = repo.getOrCreateConversation(customer.id);
    const r = appts.book({
      customerId: customer.id,
      conversationId: conv.id,
      sede: body.data.sede,
      fecha: body.data.fecha,
      hora: body.data.hora,
      nombre: body.data.nombre,
      motivo: body.data.motivo,
      source: "panel",
    });
    return r.ok ? { appointment: one(r.value.id) } : reply409(reply, r);
  });

  app.post("/api/agenda/:id/cancel", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const a = apptById(req);
    if (!a) return reply.code(404).send({ error: "cita no encontrada" });
    const r = appts.cancel(a.id);
    return r.ok ? { appointment: one(a.id) } : reply409(reply, r);
  });

  app.post("/api/agenda/:id/reschedule", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const a = apptById(req);
    if (!a) return reply.code(404).send({ error: "cita no encontrada" });
    const body = z.object({ fecha: ymd, hora: hm }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "datos inválidos" });
    const r = appts.reschedule(a.id, body.data);
    return r.ok ? { appointment: one(a.id) } : reply409(reply, r);
  });

  app.post("/api/agenda/:id/status", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const a = apptById(req);
    if (!a) return reply.code(404).send({ error: "cita no encontrada" });
    const body = z.object({ status: z.enum(["completada", "no_asistio"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "estado inválido" });
    const r = appts.markStatus(a.id, body.data.status);
    if (r.ok) bus.emit({ type: "agenda", conversationId: 0 });
    return r.ok ? { appointment: one(a.id) } : reply409(reply, r);
  });

  app.post("/api/agenda/:id/resync", async (req, reply) => {
    if (!appts?.enabled) return agendaOff(reply);
    const a = apptById(req);
    if (!a) return reply.code(404).send({ error: "cita no encontrada" });
    const r = appts.retryGoogle(a.id);
    return r.ok ? { appointment: one(a.id) } : reply409(reply, r);
  });

  // ---- estado ----
  app.get("/api/status", async () => ({
    llm: { provider: d.info.provider, model: d.info.model },
    sendConfigured: d.info.sendConfigured,
    alertsConfigured: d.info.alertChannel !== "none",
    alertChannel: d.info.alertChannel,
    knowledgePending: d.info.knowledgePending(),
    outbox: repo.outboxCounts(),
    conversations: repo.conversationCounts(),
    timezone: d.cfg.timezone,
    appointmentsEnabled: Boolean(appts?.enabled),
  }));

  // ---- tiempo real (SSE) ----
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const unsubscribe = bus.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    keepAlive.unref();
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
}

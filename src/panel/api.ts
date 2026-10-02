import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LEAD_STAGES } from "../agent/tools.js";
import type { Config } from "../config.js";
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
  /** Datos informativos para la pantalla de estado. */
  info: { provider: string; model: string; knowledgePending: () => string[] };
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

  // ---- estado ----
  app.get("/api/status", async () => ({
    llm: { provider: d.info.provider, model: d.info.model },
    n8nSendConfigured: d.cfg.n8nSendUrl !== "",
    alertsConfigured: d.cfg.alertUrl !== "",
    knowledgePending: d.info.knowledgePending(),
    outbox: repo.outboxCounts(),
    conversations: repo.conversationCounts(),
    timezone: d.cfg.timezone,
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

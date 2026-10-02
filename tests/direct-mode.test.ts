import http from "node:http";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConversationService } from "../src/conversation.js";
import { AlertDispatcher, formatAlertText, selectNotifier, TelegramNotifier, type AlertPayload } from "../src/notify.js";
import { Outbox, PermanentSendError } from "../src/outbox.js";
import { buildApp } from "../src/server.js";
import { CloudApiSender } from "../src/whatsapp/cloud.js";
import { sign } from "../src/whatsapp/signature.js";
import { metaPayload, say, setup, testConfig } from "./helpers.js";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";

const log = pino({ level: "silent" });

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function senderWith(handler: (url: string, init: any) => Response | Promise<Response>) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, sender: new CloudApiSender({ accessToken: "TOKEN-SECRETO", phoneNumberId: "1234567890", graphVersion: "v23.0", fetchImpl }) };
}

describe("CloudApiSender", () => {
  it("envía un texto por la Graph API con el token y devuelve el id del mensaje", async () => {
    const { calls, sender } = senderWith(() => jsonResponse(200, { messages: [{ id: "wamid.ABC" }] }));
    const r = await sender.send({ outboxId: 1, messageId: 2, to: "51987654321", text: "Hola Ana" });
    expect(r.waMessageId).toBe("wamid.ABC");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer TOKEN-SECRETO");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "51987654321",
      type: "text",
      text: { preview_url: false, body: "Hola Ana" },
    });
  });

  it("los rechazos permanentes (4xx) lanzan PermanentSendError con el código de Meta", async () => {
    const { sender } = senderWith(() =>
      jsonResponse(400, { error: { code: 131047, message: "Re-engagement message" } }),
    );
    const err = await sender.send({ outboxId: 1, messageId: 1, to: "1", text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentSendError);
    expect(err.message).toContain("131047");
    expect(err.message).toContain("Re-engagement");
    const bad = senderWith(() => jsonResponse(401, { error: { code: 190, message: "Invalid OAuth access token" } }));
    expect(await bad.sender.send({ outboxId: 1, messageId: 1, to: "1", text: "x" }).catch((e) => e)).toBeInstanceOf(PermanentSendError);
  });

  it("los errores temporales (5xx, 429, límites de velocidad, red) se pueden reintentar", async () => {
    for (const res of [
      jsonResponse(500, {}),
      jsonResponse(429, {}),
      jsonResponse(400, { error: { code: 130429, message: "Rate limit hit" } }),
      jsonResponse(400, { error: { code: 131056, message: "pair rate limit" } }),
    ]) {
      const { sender } = senderWith(() => res.clone());
      const err = await sender.send({ outboxId: 1, messageId: 1, to: "1", text: "x" }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentSendError);
    }
    const down = senderWith(() => {
      throw new Error("ECONNRESET");
    });
    const err = await down.sender.send({ outboxId: 1, messageId: 1, to: "1", text: "x" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(PermanentSendError);
    expect(err.message).toContain("ECONNRESET");
  });

  it("el token de acceso nunca aparece en los mensajes de error", async () => {
    const { sender } = senderWith(() => jsonResponse(400, { error: { code: 100, message: "Invalid parameter" } }));
    const err = await sender.send({ outboxId: 1, messageId: 1, to: "1", text: "x" }).catch((e) => e);
    expect(err.message).not.toContain("TOKEN-SECRETO");
  });
});

describe("Outbox con rechazos permanentes", () => {
  function seed() {
    const repo = new Repo(openDb(":memory:"));
    const c = repo.upsertCustomer("51900");
    const conv = repo.getOrCreateConversation(c.id);
    repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: "hola" });
    return { repo, conv };
  }

  it("un PermanentSendError marca el mensaje como fallido al primer intento, sin reintentar", async () => {
    const { repo, conv } = seed();
    let attempts = 0;
    const outbox = new Outbox(repo, { send: async () => { attempts++; throw new PermanentSendError("rechazado"); } }, log);
    outbox.enqueue({ conversationId: conv.id, toWaId: "51900", body: "hola", author: "bot" });
    await outbox.flush();
    await outbox.flush();
    expect(attempts).toBe(1);
    expect(repo.db.prepare("SELECT status, attempts, last_error FROM outbox").get()).toEqual({ status: "failed", attempts: 1, last_error: "rechazado" });
    expect(repo.lastMessage(conv.id)!.status).toBe("failed");
  });

  it("un error común sigue reintentándose", async () => {
    const { repo, conv } = seed();
    const outbox = new Outbox(repo, { send: async () => { throw new Error("red caída"); } }, log);
    outbox.enqueue({ conversationId: conv.id, toWaId: "51900", body: "hola", author: "bot" });
    await outbox.flush();
    expect(repo.db.prepare("SELECT status, attempts FROM outbox").get()).toEqual({ status: "pending", attempts: 1 });
  });
});

describe("webhook directo de Meta (/webhook)", () => {
  const withVerify = () => setup([say("¡Hola!")], { WA_VERIFY_TOKEN: "verifica-123" });

  it("GET: devuelve el desafío en texto plano si el token es correcto y rechaza lo demás", async () => {
    const ctx = withVerify();
    const ok = await ctx.app.inject({
      method: "GET",
      url: "/webhook?hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=1158201444",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("1158201444");
    expect(ok.headers["content-type"]).toContain("text/plain");

    for (const url of [
      "/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1",
      "/webhook?hub.mode=unsubscribe&hub.verify_token=verifica-123&hub.challenge=1",
      "/webhook?hub.mode=subscribe&hub.verify_token=verifica-123",
      "/webhook",
    ]) {
      expect((await ctx.app.inject({ method: "GET", url })).statusCode, url).toBe(403);
    }
  });

  it("GET: sin WA_VERIFY_TOKEN configurado nunca verifica (ni siquiera con token vacío)", async () => {
    const ctx = setup([say("x")]);
    const res = await ctx.app.inject({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1" });
    expect(res.statusCode).toBe(403);
  });

  const post = (ctx: ReturnType<typeof setup>, payload: unknown, secret = "secreto") => {
    const body = JSON.stringify(payload);
    return ctx.app.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, secret) },
      payload: body,
    });
  };

  it("POST: acepta mensajes con firma válida (sin token interno), responde y deduplica", async () => {
    const ctx = withVerify();
    const payload = metaPayload("wamid.d1", "51987654321", "Hola", "Ana");
    expect((await post(ctx, payload)).statusCode).toBe(202);
    await post(ctx, payload);
    await ctx.queue.idle();
    await ctx.outbox.flush();
    expect(ctx.sender.sent.map((s) => s.text)).toEqual(["¡Hola!"]);
  });

  it("POST: la firma es obligatoria", async () => {
    const ctx = withVerify();
    expect((await post(ctx, metaPayload("w", "1", "hola"), "otro-secreto")).statusCode).toBe(401);
    const noHeader = await ctx.app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(noHeader.statusCode).toBe(401);
    await ctx.queue.idle();
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it("POST: los estados de entrega actualizan el mensaje enviado", async () => {
    const ctx = withVerify();
    await post(ctx, metaPayload("wamid.d2", "51987654321", "Hola"));
    await ctx.queue.idle();
    await ctx.outbox.flush();
    const wamid = `wamid.out.${ctx.sender.sent[0]!.outboxId}`;
    await post(ctx, { entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: "read" }] } }] }] });
    const customer = ctx.repo.upsertCustomer("51987654321");
    expect(ctx.repo.lastMessage(ctx.repo.getOrCreateConversation(customer.id).id)!.status).toBe("read");
  });

  it("en producción sin INTERNAL_TOKEN no se expone /api/inbound (solo /webhook)", async () => {
    const cfg = loadConfig({
      NODE_ENV: "production", WA_APP_SECRET: "s", WA_ACCESS_TOKEN: "t", WA_PHONE_NUMBER_ID: "1", WA_VERIFY_TOKEN: "v",
      ADMIN_PASSWORD: "una-clave-larga-1", SESSION_SECRET: "x".repeat(32),
    } as NodeJS.ProcessEnv);
    const ctx = setup([say("x")]);
    const app = buildApp({ cfg, repo: ctx.repo, conversations: ctx.conversations, log });
    expect((await app.inject({ method: "POST", url: "/api/inbound", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/webhook?hub.mode=subscribe&hub.verify_token=v&hub.challenge=7" })).body).toBe("7");
  });
});

describe("validación de la configuración en producción", () => {
  const base = { NODE_ENV: "production", ADMIN_PASSWORD: "una-clave-larga-1", SESSION_SECRET: "x".repeat(32) };
  const load = (env: Record<string, string>) => () => loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);

  it("modo directo: exige App Secret, Phone Number ID y verify token", () => {
    expect(load({ WA_ACCESS_TOKEN: "t", WA_APP_SECRET: "s", WA_PHONE_NUMBER_ID: "1", WA_VERIFY_TOKEN: "v" })).not.toThrow();
    expect(load({ WA_ACCESS_TOKEN: "t", WA_PHONE_NUMBER_ID: "1", WA_VERIFY_TOKEN: "v" })).toThrow("WA_APP_SECRET");
    expect(load({ WA_ACCESS_TOKEN: "t", WA_APP_SECRET: "s", WA_VERIFY_TOKEN: "v" })).toThrow("WA_PHONE_NUMBER_ID");
    expect(load({ WA_ACCESS_TOKEN: "t", WA_APP_SECRET: "s", WA_PHONE_NUMBER_ID: "1" })).toThrow("WA_VERIFY_TOKEN");
  });

  it("modo n8n: exige el token interno; sin ningún envío configurado, falla", () => {
    expect(load({ N8N_SEND_URL: "https://n8n/x", WA_APP_SECRET: "s", INTERNAL_TOKEN: "secreto-largo" })).not.toThrow();
    expect(load({ N8N_SEND_URL: "https://n8n/x", WA_APP_SECRET: "s" })).toThrow("INTERNAL_TOKEN");
    expect(load({ WA_APP_SECRET: "s" })).toThrow("WA_ACCESS_TOKEN");
  });

  it("la versión de la Graph API y la URL base son configurables", () => {
    const cfg = testConfig({ WA_GRAPH_VERSION: "v99.0", WA_GRAPH_BASE_URL: "http://localhost:9/" });
    expect([cfg.waGraphVersion, cfg.waGraphBaseUrl]).toEqual(["v99.0", "http://localhost:9"]);
    expect(testConfig().waGraphVersion).toBe("v23.0");
  });
});

describe("alertas por Telegram", () => {
  const alert: AlertPayload = {
    type: "escalado", conversationId: 3, customerName: "Ana *Torres* _x_", waId: "51987654321",
    reason: "Pide hablar con una persona", lastMessage: "Quiero [hablar](http://malo.example) con alguien", panelUrl: "http://192.168.1.50:3001/?c=3",
  };

  it("formatea texto plano con el motivo, el último mensaje y el enlace al panel", () => {
    const text = formatAlertText(alert);
    expect(text.split("\n")).toEqual([
      "Conversación escalada",
      "Cliente: Ana *Torres* _x_ (+51987654321)",
      "Motivo: Pide hablar con una persona",
      "Último mensaje del cliente: Quiero [hablar](http://malo.example) con alguien",
      "Abrir la conversación: http://192.168.1.50:3001/?c=3",
    ]);
    expect(formatAlertText({ ...alert, lastMessage: "x".repeat(900), panelUrl: undefined })).toContain("…");
  });

  it("hace POST al bot sin parse_mode (el texto del cliente no puede inyectar formato)", async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => {
      seen = { url, body: JSON.parse(init.body) };
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    await new TelegramNotifier("123:ABC", "-1001", fake).notify(alert);
    expect(seen.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(seen.body.chat_id).toBe("-1001");
    expect(seen.body.parse_mode).toBeUndefined();
    expect(seen.body.disable_web_page_preview).toBe(true);
    expect(seen.body.text).toContain("Ana *Torres*");
  });

  it("si Telegram rechaza, el error explica el motivo pero no incluye el token", async () => {
    const fake = (async () => jsonResponse(401, { ok: false, description: "Unauthorized" })) as unknown as typeof fetch;
    const err = await new TelegramNotifier("123:ABC", "1", fake).notify(alert).catch((e) => e);
    expect(err.message).toBe("Telegram respondió 401: Unauthorized");
    expect(err.message).not.toContain("123:ABC");
  });

  it("elige Telegram, luego n8n, luego nada", () => {
    const sel = (c: object) => selectNotifier({ telegramBotToken: "", telegramChatId: "", alertUrl: "", internalToken: "t", ...c }).channel;
    expect(sel({ telegramBotToken: "x", telegramChatId: "1", alertUrl: "http://n8n" })).toBe("telegram");
    expect(sel({ telegramBotToken: "x" })).toBe("none");
    expect(sel({ alertUrl: "http://n8n" })).toBe("n8n");
    expect(sel({})).toBe("none");
  });
});

describe("extremo a extremo con Meta y Telegram simulados", () => {
  async function fakeServer(handler: (req: http.IncomingMessage, body: string) => { status: number; body: unknown }) {
    const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
        const r = handler(req, raw);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { seen, url, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it("mensaje entrante firmado → respuesta del bot enviada a la Graph API → alerta a Telegram al escalar", async () => {
    const graph = await fakeServer(() => ({ status: 200, body: { messages: [{ id: "wamid.REAL1" }] } }));
    const telegram = await fakeServer(() => ({ status: 200, body: { ok: true } }));
    try {
      const ctx = setup(
        [
          { text: "", toolCalls: [{ id: "c1", name: "handoff_to_human", input: { reason: "pide un asesor" } }] },
          say("Un asesor te escribirá en breve."),
        ],
        { WA_VERIFY_TOKEN: "v", WA_GRAPH_BASE_URL: graph.url, WA_ACCESS_TOKEN: "TOK", WA_PHONE_NUMBER_ID: "999" },
      );
      const outbox = new Outbox(ctx.repo, new CloudApiSender({
        accessToken: ctx.cfg.waAccessToken, phoneNumberId: ctx.cfg.waPhoneNumberId, graphVersion: ctx.cfg.waGraphVersion, baseUrl: ctx.cfg.waGraphBaseUrl,
      }), log);
      const alerts = new AlertDispatcher(new TelegramNotifier("111:AAA", "42", fetch, telegram.url), log);
      const conversations = new ConversationService({
        repo: ctx.repo, agent: ctx.agent, outbox, queue: ctx.queue, log, debounceMs: 0, bus: ctx.bus, alerts, panelUrl: "http://panel.test",
      });
      const app = buildApp({ cfg: ctx.cfg, repo: ctx.repo, conversations, log });

      const body = JSON.stringify(metaPayload("wamid.IN1", "51987654321", "quiero hablar con alguien", "Ana"));
      const res = await app.inject({ method: "POST", url: "/webhook", headers: { "content-type": "application/json", "x-hub-signature-256": sign(body, "secreto") }, payload: body });
      expect(res.statusCode).toBe(202);
      await ctx.queue.idle();
      await outbox.flush();
      await new Promise((r) => setTimeout(r, 50)); // la alerta sale sin bloquear la respuesta

      expect(graph.seen).toHaveLength(1);
      expect(graph.seen[0]!.url).toBe("/v23.0/999/messages");
      expect(graph.seen[0]!.headers.authorization).toBe("Bearer TOK");
      expect(graph.seen[0]!.body).toMatchObject({ to: "51987654321", type: "text", text: { body: "Un asesor te escribirá en breve." } });

      const customer = ctx.repo.upsertCustomer("51987654321");
      const conv = ctx.repo.getOrCreateConversation(customer.id);
      expect(conv.mode).toBe("escalado");
      expect(ctx.repo.lastMessage(conv.id)).toMatchObject({ author: "bot", status: "sent", wa_message_id: "wamid.REAL1" });

      expect(telegram.seen).toHaveLength(1);
      expect(telegram.seen[0]!.url).toBe("/bot111:AAA/sendMessage");
      expect(telegram.seen[0]!.body.text).toContain("Conversación escalada");
      expect(telegram.seen[0]!.body.text).toContain("pide un asesor");
      expect(telegram.seen[0]!.body.text).toContain(`http://panel.test/?c=${conv.id}`);
    } finally {
      await graph.close();
      await telegram.close();
    }
  });
});


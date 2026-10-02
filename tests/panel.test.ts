import { describe, expect, it } from "vitest";
import { Auth, hashPassword, verifyHash } from "../src/panel/auth.js";
import { buildPanelApp } from "../src/panel/server.js";
import { say, setup } from "./helpers.js";

const PASSWORD = "clave-segura-123";

async function panelSetup(steps = [say("respuesta del bot")]) {
  const ctx = setup(steps);
  const auth = new Auth({ password: PASSWORD, secret: "s".repeat(32), secure: false });
  const panel = await buildPanelApp({
    cfg: ctx.cfg,
    repo: ctx.repo,
    outbox: ctx.outbox,
    bus: ctx.bus,
    auth,
    log: ctx.log,
    info: { provider: "ollama", model: "fake", knowledgePending: () => [] },
    webDir: "/ruta/que/no/existe",
  });
  const login = async () => {
    const res = await panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
    return String(res.headers["set-cookie"]).split(";")[0]!;
  };
  return { ...ctx, panel, auth, login };
}

type Ctx = Awaited<ReturnType<typeof panelSetup>>;

/** Crea un cliente con una conversación y mensajes. */
function seed(ctx: Ctx, waId: string, name: string, texts: string[], mode: "bot" | "humano" | "escalado" = "bot", at = new Date()) {
  const customer = ctx.repo.upsertCustomer(waId, name);
  const conv = ctx.repo.getOrCreateConversation(customer.id);
  texts.forEach((t, i) =>
    ctx.repo.addMessage({
      conversationId: conv.id,
      direction: "in",
      author: "cliente",
      body: t,
      createdAt: new Date(at.getTime() + i).toISOString(),
    }),
  );
  ctx.repo.setMode(conv.id, mode);
  return { customer, conv };
}

describe("autenticación del panel", () => {
  it("hash de contraseña: verifica la correcta y rechaza otras o formatos inválidos", () => {
    const h = hashPassword("mi-clave-larga");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyHash("mi-clave-larga", h)).toBe(true);
    expect(verifyHash("otra-clave", h)).toBe(false);
    expect(verifyHash("x", "basura")).toBe(false);
  });

  it("sin cookie no hay acceso; con login correcto sí; la cookie es HttpOnly y SameSite=Strict", async () => {
    const ctx = await panelSetup();
    expect((await ctx.panel.inject({ method: "GET", url: "/api/conversations" })).statusCode).toBe(401);
    expect((await ctx.panel.inject({ method: "GET", url: "/api/auth/me" })).json()).toEqual({ authenticated: false, configured: true });

    const bad = await ctx.panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: "mala" } });
    expect(bad.statusCode).toBe(401);

    const ok = await ctx.panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const setCookie = String(ok.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(";")[0]!;
    expect((await ctx.panel.inject({ method: "GET", url: "/api/conversations", headers: { cookie } })).statusCode).toBe(200);
    expect((await ctx.panel.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json().authenticated).toBe(true);
  });

  it("rechaza cookies manipuladas o vencidas", async () => {
    let now = 1_000_000;
    const auth = new Auth({ password: "x", secret: "k".repeat(32), secure: true, ttlMs: 1000, now: () => now });
    const cookie = auth.issueCookie();
    expect(cookie).toMatch(/Secure/);
    const value = cookie.split(";")[0]!;
    expect(auth.isAuthenticated(value)).toBe(true);
    expect(auth.isAuthenticated(value.slice(0, -2) + "xx")).toBe(false);
    now += 2000;
    expect(auth.isAuthenticated(value)).toBe(false);
  });

  it("limita los intentos fallidos por IP", async () => {
    const ctx = await panelSetup();
    const attempt = () => ctx.panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: "mala" } });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(429);
    // ni con la contraseña correcta mientras dure el bloqueo
    const ok = await ctx.panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } });
    expect(ok.statusCode).toBe(429);
  });

  it("sin contraseña configurada el login responde 503", async () => {
    const ctx = setup([say("x")]);
    const panel = await buildPanelApp({
      cfg: ctx.cfg, repo: ctx.repo, outbox: ctx.outbox, bus: ctx.bus, log: ctx.log,
      auth: new Auth({ secret: "", secure: false }),
      info: { provider: "x", model: "y", knowledgePending: () => [] }, webDir: "/no",
    });
    expect((await panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: "x" } })).statusCode).toBe(503);
  });

  it("rechaza peticiones que modifican datos desde otro origen (CSRF)", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const { conv } = seed(ctx, "51900", "Ana", ["hola"]);
    const res = await ctx.panel.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/takeover`,
      headers: { cookie, origin: "https://sitio-malicioso.example", host: "panel.local" },
    });
    expect(res.statusCode).toBe(403);
    const same = await ctx.panel.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/takeover`,
      headers: { cookie, origin: "http://panel.local", host: "panel.local" },
    });
    expect(same.statusCode).toBe(200);
    const weird = await ctx.panel.inject({ method: "POST", url: `/api/conversations/${conv.id}/release`, headers: { cookie, origin: "null" } });
    expect(weird.statusCode).toBe(403);
  });
});

describe("bandeja de conversaciones", () => {
  it("lista con filtros, búsqueda, no leídos y estado de la ventana de 24 h", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    seed(ctx, "51911", "Ana Pérez", ["necesito una impresora"], "bot");
    seed(ctx, "51922", "Luis", ["quiero un lector"], "escalado");
    seed(ctx, "51933", "Marta", ["hola"], "humano", new Date(Date.now() - 30 * 3600_000));

    const get = async (qs = "") =>
      (await ctx.panel.inject({ method: "GET", url: `/api/conversations${qs}`, headers: { cookie } })).json().conversations as any[];

    expect(await get()).toHaveLength(3);
    expect((await get("?filter=escalado")).map((c) => c.customer.name)).toEqual(["Luis"]);
    expect((await get("?filter=humano")).map((c) => c.customer.name)).toEqual(["Marta"]);
    expect((await get("?q=impresora")).map((c) => c.customer.name)).toEqual(["Ana Pérez"]);
    expect((await get("?q=51922")).map((c) => c.customer.name)).toEqual(["Luis"]);
    expect((await get("?q=%25")).length).toBe(0); // los comodines se escapan
    expect((await get("?filter=sin_leer")).length).toBe(3);

    const all = await get();
    const marta = all.find((c) => c.customer.name === "Marta");
    expect(marta.window.open).toBe(false);
    expect(all.find((c) => c.customer.name === "Ana Pérez").window.open).toBe(true);
    expect(all[0].lastBody).toBeTruthy();
    expect((await ctx.panel.inject({ method: "GET", url: "/api/conversations?filter=otra", headers: { cookie } })).statusCode).toBe(400);
  });

  it("abrir una conversación devuelve el hilo con notas y la marca como leída", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const { conv } = seed(ctx, "51911", "Ana", ["hola", "¿tienen stock?"]);
    ctx.repo.addMessage({ conversationId: conv.id, direction: "out", author: "nota", body: "nota interna", status: "internal" });

    const res = await ctx.panel.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie } });
    const body = res.json();
    expect(body.messages.map((m: any) => [m.author, m.body])).toEqual([
      ["cliente", "hola"],
      ["cliente", "¿tienen stock?"],
      ["nota", "nota interna"],
    ]);
    expect(body.customer.waId).toBe("51911");
    expect(ctx.repo.getConversation(conv.id)!.unread).toBe(0);
    expect((await ctx.panel.inject({ method: "GET", url: "/api/conversations/9999", headers: { cookie } })).statusCode).toBe(404);
    expect((await ctx.panel.inject({ method: "GET", url: "/api/conversations/abc", headers: { cookie } })).statusCode).toBe(404);
  });
});

describe("intervenir en una conversación", () => {
  it("tomar el control y devolver al bot cambian el modo y dejan notas internas", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const { conv } = seed(ctx, "51911", "Ana", ["hola"]);
    const events: string[] = [];
    ctx.bus.subscribe((e) => events.push(`${e.type}:${e.conversationId}`));

    const t = await ctx.panel.inject({ method: "POST", url: `/api/conversations/${conv.id}/takeover`, headers: { cookie } });
    expect(t.json().conversation.mode).toBe("humano");
    const r = await ctx.panel.inject({ method: "POST", url: `/api/conversations/${conv.id}/release`, headers: { cookie } });
    expect(r.json().conversation.mode).toBe("bot");
    const notes = r.json().messages.filter((m: any) => m.author === "nota").map((m: any) => m.body);
    expect(notes).toEqual(["Un asesor tomó el control de la conversación", "El asistente retomó la conversación"]);
    expect(events).toEqual([`conversation:${conv.id}`, `conversation:${conv.id}`]);
  });

  it("al escribir con el bot activo, la persona toma el control y el mensaje sale por la outbox como 'humano'", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const { conv } = seed(ctx, "51911", "Ana", ["hola"]);

    const res = await ctx.panel.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/send`,
      headers: { cookie },
      payload: { text: "  Hola Ana, te ayudo yo.  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.mode).toBe("humano");
    await ctx.outbox.flush();
    expect(ctx.sender.sent.map((s) => [s.to, s.text])).toEqual([["51911", "Hola Ana, te ayudo yo."]]);
    const last = ctx.repo.lastMessage(conv.id)!;
    expect([last.author, last.status]).toEqual(["humano", "sent"]);
  });

  it("no deja enviar fuera de la ventana de 24 h, a clientes dados de baja, ni mensajes vacíos", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const old = seed(ctx, "51911", "Vieja", ["hola"], "humano", new Date(Date.now() - 30 * 3600_000));
    const res = await ctx.panel.inject({ method: "POST", url: `/api/conversations/${old.conv.id}/send`, headers: { cookie }, payload: { text: "hola" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("window_closed");

    const baja = seed(ctx, "51922", "Baja", ["stop"]);
    ctx.repo.setOptedOut(baja.customer.id, true);
    const res2 = await ctx.panel.inject({ method: "POST", url: `/api/conversations/${baja.conv.id}/send`, headers: { cookie }, payload: { text: "hola" } });
    expect(res2.json().code).toBe("opted_out");

    const ok = seed(ctx, "51933", "Ok", ["hola"]);
    expect((await ctx.panel.inject({ method: "POST", url: `/api/conversations/${ok.conv.id}/send`, headers: { cookie }, payload: { text: "   " } })).statusCode).toBe(400);
    await ctx.outbox.flush();
    expect(ctx.sender.sent).toHaveLength(0);
  });

  it("notas internas no se envían al cliente", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const { conv } = seed(ctx, "51911", "Ana", ["hola"]);
    const res = await ctx.panel.inject({ method: "POST", url: `/api/conversations/${conv.id}/notes`, headers: { cookie }, payload: { text: "Pidió factura" } });
    expect(res.json().messages.at(-1)).toMatchObject({ author: "nota", body: "Pidió factura" });
    await ctx.outbox.flush();
    expect(ctx.sender.sent).toHaveLength(0);
  });

  it("una vez tomado el control, el bot no responde a los nuevos mensajes del cliente", async () => {
    const ctx = await panelSetup([say("no debería salir")]);
    const cookie = await ctx.login();
    const { conv } = seed(ctx, "51911", "Ana", ["hola"]);
    await ctx.panel.inject({ method: "POST", url: `/api/conversations/${conv.id}/takeover`, headers: { cookie } });
    ctx.conversations.ingest({ waMessageId: "w1", from: "51911", body: "¿siguen ahí?" });
    await ctx.queue.idle();
    await ctx.outbox.flush();
    expect(ctx.sender.sent).toHaveLength(0);
    expect(ctx.provider.calls).toHaveLength(0);
  });
});

describe("ficha del cliente y estado", () => {
  it("edita nombre y etapa, agrega y borra datos recordados", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    const { customer, conv } = seed(ctx, "51911", "Ana", ["hola"]);

    const p = await ctx.panel.inject({ method: "PATCH", url: `/api/customers/${customer.id}`, headers: { cookie }, payload: { name: "Ana Pérez", stage: "cotizando", summary: "Quiere 3 ticketeras" } });
    expect(p.json().customer).toMatchObject({ name: "Ana Pérez", stage: "cotizando", summary: "Quiere 3 ticketeras" });
    expect((await ctx.panel.inject({ method: "PATCH", url: `/api/customers/${customer.id}`, headers: { cookie }, payload: { stage: "inventada" } })).statusCode).toBe(400);

    const f = await ctx.panel.inject({ method: "PUT", url: `/api/customers/${customer.id}/facts`, headers: { cookie }, payload: { key: "Tipo Negocio", value: "Farmacia" } });
    expect(f.json().customer.facts).toEqual([{ key: "tipo_negocio", value: "Farmacia" }]);
    const d = await ctx.panel.inject({ method: "DELETE", url: `/api/customers/${customer.id}/facts/tipo_negocio`, headers: { cookie } });
    expect(d.json().customer.facts).toEqual([]);
    expect(conv.id).toBeGreaterThan(0);
  });

  it("estado: modelo, conteos y alertas configuradas", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    seed(ctx, "51911", "Ana", ["hola"], "escalado");
    seed(ctx, "51922", "Luis", ["hola"], "humano");
    const s = (await ctx.panel.inject({ method: "GET", url: "/api/status", headers: { cookie } })).json();
    expect(s.llm).toEqual({ provider: "ollama", model: "fake" });
    expect(s.conversations).toEqual({ escalado: 1, humano: 1, unread: 2 });
    expect(s.outbox).toEqual({ pending: 0, failed: 0 });
    expect(s.alertsConfigured).toBe(false);
  });
});

describe("tiempo real (SSE)", () => {
  it("entrega los eventos del bus a un panel autenticado y rechaza a los demás", async () => {
    const ctx = await panelSetup();
    const cookie = await ctx.login();
    await ctx.panel.listen({ port: 0, host: "127.0.0.1" });
    const { port } = ctx.panel.server.address() as { port: number };
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/events`)).status).toBe(401);

      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie }, signal: controller.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const read = async () => new TextDecoder().decode((await reader.read()).value);
      expect(await read()).toContain("retry:");
      ctx.bus.emit({ type: "message", conversationId: 7 });
      const chunk = await read();
      expect(chunk).toContain("event: message");
      expect(chunk).toContain('"conversationId":7');
      controller.abort();
    } finally {
      await ctx.panel.close();
    }
  });
});

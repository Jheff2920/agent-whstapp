import pino from "pino";
import { describe, expect, it } from "vitest";
import { AlertDispatcher, HttpNotifier, type AlertPayload } from "../src/notify.js";
import { callTool, metaPayload, say, setup } from "./helpers.js";
import { sign } from "../src/whatsapp/signature.js";

const log = pino({ level: "silent" });
const alert = (over: Partial<AlertPayload> = {}): AlertPayload => ({
  type: "escalado", conversationId: 1, customerName: "Ana", waId: "51911", ...over,
});

describe("AlertDispatcher", () => {
  it("no repite la misma alerta dentro del enfriamiento, pero sí otra conversación u otro tipo", async () => {
    let t = 0;
    const sent: AlertPayload[] = [];
    const d = new AlertDispatcher({ notify: async (a) => void sent.push(a) }, log, () => t);
    d.dispatch(alert());
    d.dispatch(alert());
    d.dispatch(alert({ conversationId: 2 }));
    d.dispatch(alert({ type: "mensaje_pendiente" }));
    expect(sent.map((a) => `${a.type}:${a.conversationId}`)).toEqual(["escalado:1", "escalado:2", "mensaje_pendiente:1"]);
    t = 61_000;
    d.dispatch(alert());
    expect(sent).toHaveLength(4);
    d.dispatch(alert({ type: "mensaje_pendiente" })); // enfriamiento de 10 min
    expect(sent).toHaveLength(4);
  });

  it("si el envío falla no lanza y permite reintentar de inmediato", async () => {
    let calls = 0;
    const d = new AlertDispatcher({ notify: async () => { calls++; throw new Error("n8n caído"); } }, log, () => 0);
    d.dispatch(alert());
    await new Promise((r) => setTimeout(r, 0));
    d.dispatch(alert());
    expect(calls).toBe(2);
  });
});

describe("HttpNotifier", () => {
  it("hace POST con el token interno y falla si n8n no responde 2xx", async () => {
    let seen: any;
    const ok = (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await new HttpNotifier("http://n8n/hook", "tok", ok).notify(alert({ reason: "x" }));
    expect(seen.headers["x-internal-token"]).toBe("tok");
    expect(seen.body).toMatchObject({ type: "escalado", waId: "51911", reason: "x" });
    const bad = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
    await expect(new HttpNotifier("http://n8n/hook", "tok", bad).notify(alert())).rejects.toThrow("502");
  });
});

describe("alertas desde el flujo de conversación", () => {
  const post = (ctx: ReturnType<typeof setup>, id: string, text: string) => {
    const body = JSON.stringify(metaPayload(id, "51911", text, "Ana"));
    return ctx.app.inject({
      method: "POST", url: "/api/inbound",
      headers: { "content-type": "application/json", "x-internal-token": "tok", "x-hub-signature-256": sign(body, "secreto") },
      payload: body,
    });
  };
  const drain = async (ctx: ReturnType<typeof setup>) => { await ctx.queue.idle(); await ctx.outbox.flush(); };

  it("avisa cuando el asistente escala, con el motivo, el último mensaje y el enlace al panel", async () => {
    const ctx = setup([callTool("handoff_to_human", { reason: "pide hablar con una persona" }), say("Un asesor te escribirá.")]);
    await post(ctx, "w1", "quiero hablar con alguien");
    await drain(ctx);
    expect(ctx.notifier.alerts).toHaveLength(1);
    expect(ctx.notifier.alerts[0]).toMatchObject({
      type: "escalado", customerName: "Ana", waId: "51911",
      reason: "pide hablar con una persona", lastMessage: "quiero hablar con alguien",
    });
    expect(ctx.notifier.alerts[0]!.panelUrl).toMatch(/^http:\/\/panel\.test\/\?c=\d+$/);
  });

  it("avisa una sola vez cuando el cliente sigue escribiendo mientras una persona atiende", async () => {
    const ctx = setup([say("no sale")]);
    const c = ctx.repo.upsertCustomer("51911", "Ana");
    ctx.repo.setMode(ctx.repo.getOrCreateConversation(c.id).id, "humano");
    await post(ctx, "w1", "¿hola?");
    await post(ctx, "w2", "¿me escuchan?");
    await drain(ctx);
    expect(ctx.notifier.alerts.map((a) => a.type)).toEqual(["mensaje_pendiente"]);
    expect(ctx.notifier.alerts[0]!.lastMessage).toBe("¿hola?");
  });

  it("avisa cuando el modelo falla y se escala por error", async () => {
    const ctx = setup([() => { throw new Error("Ollama no responde"); }]);
    await post(ctx, "w1", "hola");
    await drain(ctx);
    expect(ctx.notifier.alerts).toHaveLength(1);
    expect(ctx.notifier.alerts[0]!.reason).toContain("Ollama no responde");
  });

  it("avisa de las solicitudes de cotización con el resumen", async () => {
    const ctx = setup([callTool("create_quote_request", { summary: "3 ticketeras RED-E803B para Lima" }), say("Registrado.")]);
    await post(ctx, "w1", "necesito cotizar 3 ticketeras");
    await drain(ctx);
    expect(ctx.notifier.alerts.map((a) => a.type)).toEqual(["cotizacion"]);
    expect(ctx.notifier.alerts[0]!.reason).toBe("3 ticketeras RED-E803B para Lima");
  });

  it("una conversación normal con el bot no genera alertas", async () => {
    const ctx = setup([say("¡Hola!")]);
    await post(ctx, "w1", "hola");
    await drain(ctx);
    expect(ctx.notifier.alerts).toEqual([]);
  });
});

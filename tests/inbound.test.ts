import { describe, expect, it } from "vitest";
import { OPT_OUT_TEXT } from "../src/conversation.js";
import { FALLBACK_TEXT } from "../src/agent/agent.js";
import { sign } from "../src/whatsapp/signature.js";
import { metaPayload, say, setup } from "./helpers.js";

async function post(ctx: ReturnType<typeof setup>, payload: unknown, opts: { token?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  return ctx.app.inject({
    method: "POST",
    url: "/api/inbound",
    headers: {
      "content-type": "application/json",
      "x-internal-token": opts.token ?? "tok",
      "x-hub-signature-256": sign(body, opts.secret ?? "secreto"),
    },
    payload: body,
  });
}

const drain = async (ctx: ReturnType<typeof setup>) => {
  await ctx.queue.idle();
  await ctx.outbox.flush();
};

describe("POST /api/inbound", () => {
  it("acepta un mensaje firmado, responde con el agente y lo envía", async () => {
    const ctx = setup([say("¡Hola Ana!")]);
    const res = await post(ctx, metaPayload("wamid.1", "51900", "Hola", "Ana"));
    expect(res.statusCode).toBe(202);
    await drain(ctx);
    expect(ctx.sender.sent.map((s) => [s.to, s.text])).toEqual([["51900", "¡Hola Ana!"]]);
    const customer = ctx.repo.upsertCustomer("51900");
    expect(customer.name).toBe("Ana");
  });

  it("un reintento duplicado de Meta no genera segunda respuesta", async () => {
    const ctx = setup([say("uno"), say("dos")]);
    const payload = metaPayload("wamid.dup", "51900", "Hola");
    await post(ctx, payload);
    await drain(ctx);
    await post(ctx, payload);
    await drain(ctx);
    expect(ctx.sender.sent).toHaveLength(1);
    expect(ctx.provider.calls).toHaveLength(1);
  });

  it("rechaza token interno o firma incorrectos", async () => {
    const ctx = setup([say("x")]);
    expect((await post(ctx, metaPayload("a", "1", "h"), { token: "malo" })).statusCode).toBe(401);
    expect((await post(ctx, metaPayload("b", "1", "h"), { secret: "otro" })).statusCode).toBe(401);
    await drain(ctx);
    expect(ctx.provider.calls).toHaveLength(0);
    expect(ctx.sender.sent).toHaveLength(0);
  });

  it("si la conversación está en modo humano, guarda pero el bot no responde", async () => {
    const ctx = setup([say("no debería salir")]);
    const c = ctx.repo.upsertCustomer("51900");
    ctx.repo.setMode(ctx.repo.getOrCreateConversation(c.id).id, "humano");
    await post(ctx, metaPayload("wamid.h", "51900", "¿sigue ahí?"));
    await drain(ctx);
    expect(ctx.sender.sent).toHaveLength(0);
    const conv = ctx.repo.getOrCreateConversation(c.id);
    expect(ctx.repo.recentMessages(conv.id, 10).map((m) => m.body)).toEqual(["¿sigue ahí?"]);
  });

  it("si una persona toma el control mientras el modelo piensa, se descarta la respuesta del bot", async () => {
    const ctx = setup([
      (_req) => {
        const c = ctx.repo.upsertCustomer("51900");
        ctx.repo.setMode(ctx.repo.getOrCreateConversation(c.id).id, "humano");
        return say("respuesta tardía");
      },
    ]);
    await post(ctx, metaPayload("wamid.t", "51900", "Hola"));
    await drain(ctx);
    expect(ctx.sender.sent).toHaveLength(0);
  });

  it("baja y alta: el cliente deja de recibir respuestas y puede volver", async () => {
    const ctx = setup([say("respuesta normal")]);
    await post(ctx, metaPayload("w1", "51900", "STOP"));
    await drain(ctx);
    expect(ctx.sender.sent.map((s) => s.text)).toEqual([OPT_OUT_TEXT]);
    expect(ctx.repo.upsertCustomer("51900").opted_out).toBe(1);

    await post(ctx, metaPayload("w2", "51900", "oye"));
    await drain(ctx);
    expect(ctx.sender.sent).toHaveLength(1);

    await post(ctx, metaPayload("w3", "51900", "ALTA"));
    await drain(ctx);
    expect(ctx.repo.upsertCustomer("51900").opted_out).toBe(0);
    expect(ctx.sender.sent.at(-1)!.text).toBe("respuesta normal");
  });

  it("si el modelo falla, escala a humano y avisa al cliente", async () => {
    const ctx = setup([
      () => {
        throw new Error("Ollama no responde");
      },
    ]);
    await post(ctx, metaPayload("wamid.e", "51900", "Hola"));
    await drain(ctx);
    expect(ctx.sender.sent.map((s) => s.text)).toEqual([FALLBACK_TEXT]);
    const c = ctx.repo.upsertCustomer("51900");
    expect(ctx.repo.getOrCreateConversation(c.id).mode).toBe("escalado");
  });

  it("actualiza el estado de entrega de mensajes salientes", async () => {
    const ctx = setup([say("hola")]);
    await post(ctx, metaPayload("wamid.s", "51900", "Hola"));
    await drain(ctx);
    const waId = ctx.sender.sent[0]!.outboxId;
    const statusPayload = {
      entry: [{ changes: [{ value: { statuses: [{ id: `wamid.out.${waId}`, status: "delivered" }] } }] }],
    };
    await post(ctx, statusPayload);
    const c = ctx.repo.upsertCustomer("51900");
    const last = ctx.repo.lastMessage(ctx.repo.getOrCreateConversation(c.id).id)!;
    expect(last.status).toBe("delivered");
  });

  it("responde /health", async () => {
    const ctx = setup([say("x")]);
    expect((await ctx.app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });
});

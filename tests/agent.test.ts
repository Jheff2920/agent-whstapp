import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_TEXT, messagesToTurns } from "../src/agent/agent.js";
import { buildSystem } from "../src/agent/prompt.js";
import { callTool, say, setup } from "./helpers.js";

function customerSays(ctx: ReturnType<typeof setup>, text: string) {
  const customer = ctx.repo.upsertCustomer("51900", "Ana");
  const conv = ctx.repo.getOrCreateConversation(customer.id);
  ctx.repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: text });
  return { customer, conv };
}

describe("Agent", () => {
  it("ejecuta herramientas y devuelve el texto final", async () => {
    const ctx = setup([callTool("remember_fact", { key: "Presupuesto Mensual", value: "S/ 500" }), say("Anotado, Ana.")]);
    const { customer, conv } = customerSays(ctx, "Tengo S/ 500 al mes");
    const r = await ctx.agent.reply(conv.id);
    expect(r.text).toBe("Anotado, Ana.");
    expect(r.toolsUsed).toEqual(["remember_fact"]);
    expect(ctx.repo.getFacts(customer.id)).toEqual([{ key: "presupuesto_mensual", value: "S/ 500" }]);
    // El resultado de la herramienta se devuelve al modelo en el segundo turno
    const second = ctx.provider.calls[1]!.turns;
    expect(second.at(-1)).toMatchObject({ role: "tool", results: [{ name: "remember_fact", content: "Guardado." }] });
  });

  it("handoff_to_human escala la conversación", async () => {
    const ctx = setup([callTool("handoff_to_human", { reason: "pide hablar con una persona" }), say("Un asesor te escribirá.")]);
    const { conv } = customerSays(ctx, "quiero hablar con alguien");
    const r = await ctx.agent.reply(conv.id);
    expect(r.handoff).toBe(true);
    expect(r.handoffReason).toBe("pide hablar con una persona");
    expect(ctx.repo.getConversation(conv.id)!.mode).toBe("escalado");
  });

  it("argumentos inválidos y herramientas inexistentes vuelven al modelo como error", async () => {
    const ctx = setup([
      { text: "", toolCalls: [{ id: "1", name: "update_lead_stage", input: { stage: "inventada" } }, { id: "2", name: "no_existe", input: {} }] },
      say("ok"),
    ]);
    const { customer, conv } = customerSays(ctx, "hola");
    const r = await ctx.agent.reply(conv.id);
    expect(r.text).toBe("ok");
    const tool = ctx.provider.calls[1]!.turns.at(-1);
    expect(tool).toMatchObject({ role: "tool", results: [{ isError: true }, { isError: true }] });
    expect(ctx.repo.getCustomer(customer.id)!.stage).toBe("nuevo");
  });

  it("search_catalog solo devuelve lo que existe en el catálogo", async () => {
    const ctx = setup([callTool("search_catalog", { query: "producto" }), say("listo")]);
    const { conv } = customerSays(ctx, "qué venden");
    await ctx.agent.reply(conv.id);
    const result = (ctx.provider.calls[1]!.turns.at(-1) as any).results[0].content as string;
    expect(result).toContain("Producto de prueba A");
    expect(result).not.toContain("Servicio de prueba B");
  });

  it("si el modelo nunca termina, escala y usa el texto de respaldo", async () => {
    const ctx = setup([callTool("remember_fact", { key: "a", value: "b" })], { MAX_TOOL_ITERATIONS: "3" });
    const { conv } = customerSays(ctx, "hola");
    const r = await ctx.agent.reply(conv.id);
    expect(ctx.provider.calls).toHaveLength(3);
    expect(r.text).toBe(FALLBACK_TEXT);
    expect(r.handoff).toBe(true);
    expect(ctx.repo.getConversation(conv.id)!.mode).toBe("escalado");
  });

  it("un rechazo del modelo escala a humano", async () => {
    const ctx = setup([{ text: "", toolCalls: [], refused: true }]);
    const { conv } = customerSays(ctx, "hola");
    const r = await ctx.agent.reply(conv.id);
    expect(r.handoff).toBe(true);
    expect(r.text).toBe(FALLBACK_TEXT);
  });

  it("no responde si el último mensaje ya es del bot", async () => {
    const ctx = setup([say("x")]);
    const { conv } = customerSays(ctx, "hola");
    ctx.repo.addMessage({ conversationId: conv.id, direction: "out", author: "bot", body: "hola!" });
    const r = await ctx.agent.reply(conv.id);
    expect(r.skipped).toBeTruthy();
    expect(ctx.provider.calls).toHaveLength(0);
  });
});

describe("messagesToTurns", () => {
  it("fusiona mensajes consecutivos del mismo autor y empieza siempre por el cliente", () => {
    const mk = (direction: "in" | "out", body: string) => ({ direction, body }) as any;
    const turns = messagesToTurns([mk("out", "x"), mk("in", "a"), mk("in", "b"), mk("out", "c"), mk("in", "d")]);
    expect(turns.map((t) => [t.role, (t as any).text])).toEqual([
      ["user", "a\nb"],
      ["assistant", "c"],
      ["user", "d"],
    ]);
  });
});

describe("prompt", () => {
  it("incluye el conocimiento entregado y el perfil del cliente", () => {
    const ctx = setup([say("x")]);
    const customer = ctx.repo.upsertCustomer("51900", "Ana");
    const { stable, volatile } = buildSystem(ctx.knowledge.get(), {
      customer,
      facts: [{ key: "presupuesto", value: "500" }],
      mode: "bot",
      now: new Date("2026-10-02T15:00:00Z"),
      timezone: "America/Lima",
    });
    expect(stable).toContain("Producto de prueba A");
    expect(stable).toContain("Reseña ficticia de prueba");
    expect(volatile).toContain("Ana");
    expect(volatile).toContain("presupuesto: 500");
    expect(volatile).toMatch(/2 de octubre de 2026/);
  });

  it("sin conocimiento cargado ordena derivar y no menciona productos", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kn-vacio-"));
    const ctx = setup([say("x")], { KNOWLEDGE_DIR: empty });
    const customer = ctx.repo.upsertCustomer("51900");
    const { stable } = buildSystem(ctx.knowledge.get(), {
      customer,
      facts: [],
      mode: "bot",
      now: new Date(),
      timezone: "America/Lima",
    });
    expect(stable).toContain("Aún no hay información cargada");
    expect(stable).toContain("Vacío: no menciones productos");
    expect(stable).toContain("Sin información de sedes");
  });
});

describe("prompt con el conocimiento real", () => {
  const real = new URL("../knowledge", import.meta.url).pathname;
  const build = () => {
    const ctx = setup([say("x")], { KNOWLEDGE_DIR: real });
    const customer = ctx.repo.upsertCustomer("51900");
    return buildSystem(ctx.knowledge.get(), { customer, facts: [], mode: "bot", now: new Date(), timezone: "America/Lima" }).stable;
  };

  it("usa el índice de catálogo y la información de contacto entregada", () => {
    const stable = build();
    expect(stable).toContain("ÍNDICE: modelo, marca y precio");
    expect(stable).toContain("RedPOS RED-E803B: S/330");
    expect(stable).toContain("Cyberplaza");
    expect(stable).toContain("(+51) 960 944 717");
    // el catálogo completo (especificaciones) no se inyecta: se consulta con search_catalog
    expect(stable).not.toContain("Vida útil del cabezal");
  });

  it("incluye sedes, horarios, IGV y devoluciones entregados; sin reseñas el agente no las menciona", () => {
    const stable = build();
    expect(stable).toContain("Av. Canaval y Moreyra 345 - San Isidro, piso 7");
    expect(stable).toContain("lunes a viernes 09:00-18:00; sábado 09:00-13:00; domingo cerrado");
    expect(stable).toContain("Todos los precios incluyen IGV");
    expect(stable).toContain("No hay devolución por mal uso");
    expect(stable).toContain("envíos a nivel nacional a través de diversas empresas de transporte");
    expect(stable).toContain("boleta o factura");
    expect(stable).not.toContain("# RESEÑAS DE CLIENTES");
    expect(stable).toContain("tutea al cliente y no uses emojis");
    expect(stable).toContain("no puedes agendar citas");
  });

  it("el estado de las sedes (calculado) va en la parte volátil con la hora de Lima", () => {
    const ctx = setup([say("x")], { KNOWLEDGE_DIR: real });
    const customer = ctx.repo.upsertCustomer("51900");
    const { volatile, stable } = buildSystem(ctx.knowledge.get(), {
      customer, facts: [], mode: "bot", now: new Date("2026-10-03T19:00:00Z"), timezone: "America/Lima",
    });
    expect(volatile).toContain("- Cyberplaza: abierta ahora (cierra a las 19:00)");
    expect(volatile).toContain("- San Isidro: cerrada ahora; abre el lunes a las 09:00");
    expect(stable).not.toContain("abierta ahora"); // lo que cambia con la hora no rompe el caché del prompt estable
  });

  it("incluye los datos de pago entregados y la instrucción de no verificar pagos", () => {
    const stable = build();
    expect(stable).toContain("RUC: 20563358549");
    expect(stable).toContain("200-3002743785");
    expect(stable).toContain("003-200-003002743785-31");
    expect(stable).toContain("191-2189537-0-33");
    expect(stable).toContain("002-191-002189537033-52");
    expect(stable).toContain("Plin: 922 040 643");
    expect(stable).toContain("Yape: 949 246 186");
    expect(stable).toContain("No puedes verificar pagos");
    expect(stable).not.toMatch(/\bTODO\b/);
  });

  it("las secciones pendientes (TODO) se reemplazan por un aviso para derivar, sin exponer la marca TODO", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-todo-"));
    fs.writeFileSync(path.join(dir, "empresa.md"), "# Empresa\n\n## Pagos\nTODO\n\n## Garantía\n1 año\n");
    const ctx = setup([say("x")], { KNOWLEDGE_DIR: dir });
    const customer = ctx.repo.upsertCustomer("51900");
    const { stable } = buildSystem(ctx.knowledge.get(), { customer, facts: [], mode: "bot", now: new Date(), timezone: "America/Lima" });
    expect(stable).toContain("Sin información cargada sobre este tema");
    expect(stable).toContain("1 año");
    expect(stable).not.toMatch(/\bTODO\b/);
  });

  it("search_catalog devuelve fichas completas por modelo sin la página del PDF", async () => {
    const ctx = setup([callTool("search_catalog", { query: "RED-E803B" }), say("ok")], { KNOWLEDGE_DIR: real });
    const customer = ctx.repo.upsertCustomer("51900");
    const conv = ctx.repo.getOrCreateConversation(customer.id);
    ctx.repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: "info de la E803B" });
    await ctx.agent.reply(conv.id);
    const out = (ctx.provider.calls[1]!.turns.at(-1) as any).results[0].content as string;
    const items = JSON.parse(out);
    expect(items[0].id).toBe("RED-E803B");
    expect(items[0].precio).toBe("S/330");
    expect(items[0]).not.toHaveProperty("pagina_catalogo");
  });
});

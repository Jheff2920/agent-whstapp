import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, toAnthropicMessages } from "../src/llm/anthropic.js";
import { OllamaProvider, toOllamaMessages } from "../src/llm/ollama.js";
import type { Turn } from "../src/llm/types.js";
import { toToolSpec, buildTools } from "../src/agent/tools.js";

const turns: Turn[] = [
  { role: "user", text: "hola" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "remember_fact", input: { key: "a", value: "b" } }] },
  { role: "tool", results: [{ callId: "c1", name: "remember_fact", content: "Guardado." }] },
];

describe("Ollama", () => {
  it("mapea turnos y herramientas al formato de /api/chat y lee tool_calls", async () => {
    let body: any;
    const fake = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          message: { content: "", tool_calls: [{ function: { name: "remember_fact", arguments: { key: "x", value: "y" } } }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OllamaProvider({ url: "http://localhost:11434/", model: "m", think: false, timeoutMs: 1000, fetchImpl: fake });
    const spec = toToolSpec(buildTools({ repo: null as any, knowledge: null as any, conversationId: 1, customerId: 1, state: { handoff: false } })[1]!);
    const r = await p.complete({ system: { stable: "S", volatile: "V" }, turns, tools: [spec] });

    expect(body.model).toBe("m");
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: "S\n\nV" });
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: "remember_fact", arguments: { key: "a", value: "b" } });
    expect(body.messages[3]).toMatchObject({ tool_name: "remember_fact", content: "Guardado." });
    expect(body.tools[0].function.name).toBe("remember_fact");
    expect(body.tools[0].function.parameters.properties.key).toBeTruthy();
    expect(body.tools[0].function.parameters.$schema).toBeUndefined();
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: "remember_fact", input: { key: "x", value: "y" } });
  });

  it("no envía `think` si no se configura y propaga errores HTTP", async () => {
    let body: any;
    const ok = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: " hola " } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider({ url: "http://x", model: "m", timeoutMs: 1000, fetchImpl: ok });
    expect((await p.complete({ system: { stable: "S", volatile: "" }, turns: [], tools: [] })).text).toBe("hola");
    expect("think" in body).toBe(false);
    expect(body.tools).toBeUndefined();

    const bad = (async () => new Response('{"error":"model not found"}', { status: 404 })) as unknown as typeof fetch;
    const q = new OllamaProvider({ url: "http://x", model: "m", timeoutMs: 1000, fetchImpl: bad });
    await expect(q.complete({ system: { stable: "S", volatile: "" }, turns: [], tools: [] })).rejects.toThrow("404");
  });

  it("generateObject usa el esquema como `format` y valida la respuesta", async () => {
    let body: any;
    const fake = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: '{"n": 3}' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider({ url: "http://x", model: "m", timeoutMs: 1000, fetchImpl: fake });
    const out = await p.generateObject({ system: "s", prompt: "p", schema: z.object({ n: z.number() }) });
    expect(out).toEqual({ n: 3 });
    expect(body.format.type).toBe("object");
    expect(body.format.$schema).toBeUndefined();
  });
});

describe("toOllamaMessages", () => {
  it("emite un mensaje de herramienta por resultado", () => {
    const m = toOllamaMessages("S", [
      { role: "tool", results: [
        { callId: "1", name: "a", content: "x" },
        { callId: "2", name: "b", content: "y" },
      ] },
    ]);
    expect(m.map((x) => x.role)).toEqual(["system", "tool", "tool"]);
  });
});

describe("Anthropic", () => {
  const makeClient = (response: any) => {
    const calls: any[] = [];
    const client = { beta: { messages: { create: async (p: any) => (calls.push(p), response) } } } as any;
    return { client, calls };
  };

  it("arma la petición con caché, esfuerzo y fallbacks, y parsea texto y tool_use", async () => {
    const { client, calls } = makeClient({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "Voy a anotarlo" },
        { type: "tool_use", id: "tu1", name: "remember_fact", input: { key: "k", value: "v" } },
      ],
    });
    const p = new AnthropicProvider({ model: "claude-opus-5-5", effort: "low", fallbacks: true, client });
    const r = await p.complete({ system: { stable: "ESTABLE", volatile: "VOLATIL" }, turns, tools: [{ name: "t", description: "d", parameters: { type: "object" } }] });

    const req = calls[0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.max_tokens).toBeGreaterThanOrEqual(8000);
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.fallbacks).toBe("default");
    expect(req.thinking).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.system[0]).toMatchObject({ text: "ESTABLE", cache_control: { type: "ephemeral" } });
    expect(req.system[1]).toEqual({ type: "text", text: "VOLATIL" });
    expect(req.tools[0].input_schema).toEqual({ type: "object" });
    expect(r.text).toBe("Voy a anotarlo");
    expect(r.toolCalls).toEqual([{ id: "tu1", name: "remember_fact", input: { key: "k", value: "v" } }]);
    // el contenido original (con bloques de razonamiento) se conserva para reenviarlo tal cual
    expect((r.raw as any[]).some((b) => b.type === "thinking")).toBe(true);
  });

  it("sin fallbacks no envía el beta; un rechazo se marca como refused", async () => {
    const { client, calls } = makeClient({ stop_reason: "refusal", content: [] });
    const p = new AnthropicProvider({ model: "m", effort: "medium", fallbacks: false, client });
    const r = await p.complete({ system: { stable: "S", volatile: "" }, turns: [{ role: "user", text: "x" }], tools: [] });
    expect(r.refused).toBe(true);
    expect(calls[0].betas).toBeUndefined();
    expect(calls[0].fallbacks).toBeUndefined();
    expect(calls[0].system).toHaveLength(1);
    expect(calls[0].tools).toBeUndefined();
  });

  it("reenvía el contenido original del asistente y agrupa los resultados de herramientas", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "c1", name: "n", input: {} }];
    const msgs = toAnthropicMessages([
      { role: "user", text: "hola" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "n", input: {} }], raw },
      { role: "tool", results: [
        { callId: "c1", name: "n", content: "ok" },
        { callId: "c2", name: "m", content: "mal", isError: true },
      ] },
    ]);
    expect(msgs[1]!.content).toBe(raw);
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "ok" },
        { type: "tool_result", tool_use_id: "c2", content: "mal", is_error: true },
      ],
    });
  });
});

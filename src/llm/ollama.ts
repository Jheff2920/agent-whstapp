import { z } from "zod";
import type {
  CompleteRequest,
  CompleteResponse,
  GenerateObjectRequest,
  LLMProvider,
  ToolCall,
  Turn,
} from "./types.js";

export interface OllamaOptions {
  url: string;
  model: string;
  think?: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

export function toOllamaMessages(system: string, turns: Turn[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  for (const t of turns) {
    if (t.role === "user") {
      out.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      const msg: OllamaMessage = { role: "assistant", content: t.text };
      if (t.toolCalls.length) {
        msg.tool_calls = t.toolCalls.map((c) => ({
          function: { name: c.name, arguments: (c.input ?? {}) as Record<string, unknown> },
        }));
      }
      out.push(msg);
    } else {
      for (const r of t.results) out.push({ role: "tool", tool_name: r.name, content: r.content });
    }
  }
  return out;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OllamaOptions) {
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async chat(body: Record<string, unknown>): Promise<{ message?: { content?: string; tool_calls?: any[] } }> {
    const res = await this.fetchImpl(`${this.opts.url.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        ...(this.opts.think === undefined ? {} : { think: this.opts.think }),
        ...body,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama respondió ${res.status}: ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as { message?: { content?: string; tool_calls?: any[] } };
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const system = [req.system.stable, req.system.volatile].filter(Boolean).join("\n\n");
    const data = await this.chat({
      messages: toOllamaMessages(system, req.turns),
      tools: req.tools.length
        ? req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined,
      options: { temperature: 0.3, num_predict: req.maxTokens ?? 1024 },
    });
    const message = data.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c, i) => ({
      id: `call_${Date.now().toString(36)}_${i}`,
      name: String(c?.function?.name ?? ""),
      input: normalizeArgs(c?.function?.arguments),
    }));
    return { text: (message.content ?? "").trim(), toolCalls };
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    const jsonSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const data = await this.chat({
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      format: jsonSchema,
      options: { temperature: 0, num_predict: 2048 },
    });
    return req.schema.parse(JSON.parse(data.message?.content ?? ""));
  }
}

function normalizeArgs(args: unknown): unknown {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args ?? {};
}

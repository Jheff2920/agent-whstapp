import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  CompleteRequest,
  CompleteResponse,
  GenerateObjectRequest,
  LLMProvider,
  ToolCall,
  Turn,
} from "./types.js";

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

export interface AnthropicOptions {
  apiKey?: string;
  model: string;
  effort: "low" | "medium" | "high";
  fallbacks: boolean;
  client?: Anthropic;
}

export function toAnthropicMessages(turns: Turn[]): Msg[] {
  const out: Msg[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      out.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      if (t.raw) {
        out.push({ role: "assistant", content: t.raw as Block[] });
        continue;
      }
      const blocks: Block[] = [];
      if (t.text) blocks.push({ type: "text", text: t.text });
      for (const c of t.toolCalls) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input as Record<string, unknown> });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({
        role: "user",
        content: t.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model;
    // Sin apiKey explícita el SDK usa ANTHROPIC_API_KEY / perfil de `ant auth login`.
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } },
    ];
    if (req.system.volatile) system.push({ type: "text", text: req.system.volatile });

    const response = await this.client.beta.messages.create({
      model: this.model,
      // El razonamiento adaptativo cuenta dentro de max_tokens: dejar margen.
      max_tokens: Math.max(req.maxTokens ?? 0, 8000),
      system,
      messages: toAnthropicMessages(req.turns),
      tools: req.tools.length
        ? req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
          }))
        : undefined,
      output_config: { effort: this.opts.effort },
      ...(this.opts.fallbacks
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });

    if (response.stop_reason === "refusal") {
      return { text: "", toolCalls: [], raw: response.content, refused: true };
    }
    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const b of response.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, input: b.input });
    }
    return { text: text.trim(), toolCalls, raw: response.content };
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8000,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { format: zodOutputFormat(req.schema as any) },
    });
    if (response.parsed_output == null) throw new Error("Claude no devolvió una salida estructurada válida");
    return response.parsed_output as T;
  }
}

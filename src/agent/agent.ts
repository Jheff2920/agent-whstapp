import type { AppointmentService } from "../appointments/service.js";
import type { Config } from "../config.js";
import type { Message, Repo } from "../db/repos.js";
import type { KnowledgeStore } from "../knowledge/loader.js";
import type { LLMProvider, ToolResult, Turn } from "../llm/types.js";
import { buildSystem } from "./prompt.js";
import { buildTools, toToolSpec, type ToolState } from "./tools.js";

/** Se envía solo si el modelo no logra producir una respuesta; el cliente no queda en silencio. */
export const FALLBACK_TEXT =
  "Gracias por escribirnos. Voy a pasar tu consulta a un asesor para que te responda lo antes posible.";

export interface AgentResult {
  text: string;
  handoff: boolean;
  handoffReason?: string;
  toolsUsed: string[];
  /** Si no se generó respuesta, el motivo. */
  skipped?: string;
}

export interface AgentDeps {
  provider: LLMProvider;
  repo: Repo;
  knowledge: KnowledgeStore;
  cfg: Pick<Config, "historyLimit" | "maxToolIterations" | "timezone">;
  getLearnings?: () => string[];
  appointments?: AppointmentService;
  onTool?: (name: string, input: unknown, output: string, isError: boolean) => void;
  now?: () => Date;
}

export function messagesToTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const role = m.direction === "in" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text += `\n${m.body}`;
    } else if (role === "user") {
      turns.push({ role: "user", text: m.body });
    } else {
      turns.push({ role: "assistant", text: m.body, toolCalls: [] });
    }
  }
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

export class Agent {
  constructor(private readonly d: AgentDeps) {}

  async reply(conversationId: number): Promise<AgentResult> {
    const { repo, provider, cfg } = this.d;
    const conversation = repo.getConversation(conversationId);
    if (!conversation) return { text: "", handoff: false, toolsUsed: [], skipped: "conversación inexistente" };
    const customer = repo.getCustomer(conversation.customer_id)!;

    const history = repo.recentMessages(conversationId, cfg.historyLimit);
    const turns = messagesToTurns(history);
    if (turns[turns.length - 1]?.role !== "user") {
      return { text: "", handoff: false, toolsUsed: [], skipped: "no hay mensaje pendiente de respuesta" };
    }

    const knowledge = this.d.knowledge.get();
    const appts = this.d.appointments;
    const system = buildSystem(knowledge, {
      customer,
      facts: repo.getFacts(customer.id),
      mode: conversation.mode,
      now: (this.d.now ?? (() => new Date()))(),
      timezone: cfg.timezone,
      learnings: this.d.getLearnings?.(),
      appointments: appts?.enabled
        ? {
            enabled: true,
            upcoming: appts.customerUpcoming(customer.id).map((a) => `#${a.id} ${appts.describe(a)}, a nombre de ${a.contact_name}`),
          }
        : undefined,
    });

    const state: ToolState = { handoff: false };
    const tools = buildTools({ repo, knowledge, conversationId, customerId: customer.id, state, appointments: appts });
    const specs = tools.map(toToolSpec);
    const toolsUsed: string[] = [];

    let text = "";
    for (let i = 0; i < cfg.maxToolIterations; i++) {
      const res = await provider.complete({ system, turns, tools: specs });

      if (res.refused) {
        state.handoff = true;
        state.handoffReason ??= "el modelo rechazó responder";
        break;
      }
      if (res.toolCalls.length === 0) {
        text = res.text;
        break;
      }

      turns.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw });
      const results: ToolResult[] = [];
      for (const call of res.toolCalls) {
        toolsUsed.push(call.name);
        const tool = tools.find((t) => t.name === call.name);
        let content: string;
        let isError = false;
        if (!tool) {
          content = `La herramienta "${call.name}" no existe.`;
          isError = true;
        } else {
          const parsed = tool.schema.safeParse(call.input);
          if (!parsed.success) {
            content = `Argumentos inválidos: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`;
            isError = true;
          } else {
            try {
              content = await tool.run(parsed.data);
            } catch (err) {
              content = `Error al ejecutar: ${(err as Error).message}`;
              isError = true;
            }
          }
        }
        this.d.onTool?.(call.name, call.input, content, isError);
        results.push({ callId: call.id, name: call.name, content, isError });
      }
      turns.push({ role: "tool", results });
    }

    if (!text) {
      if (!state.handoff) {
        state.handoff = true;
        state.handoffReason = "el asistente no pudo generar una respuesta";
        repo.setMode(conversationId, "escalado");
        repo.addMessage({
          conversationId,
          direction: "out",
          author: "nota",
          body: `Escalado a humano: ${state.handoffReason}`,
          status: "internal",
        });
      }
      text = FALLBACK_TEXT;
    }

    return {
      text,
      handoff: state.handoff,
      handoffReason: state.handoffReason,
      toolsUsed,
    };
  }
}

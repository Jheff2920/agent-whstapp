import type { Logger } from "pino";
import { FALLBACK_TEXT, type Agent } from "./agent/agent.js";
import type { Repo } from "./db/repos.js";
import type { InboundMessage } from "./whatsapp/payload.js";
import type { EventBus } from "./events.js";
import type { AlertDispatcher, AlertPayload } from "./notify.js";
import type { Outbox } from "./outbox.js";
import type { KeyedQueue } from "./queue.js";

export const OPT_OUT_TEXT = "Listo, dejaremos de escribirte. Si cambias de opinión, escribe ALTA.";
const OPT_OUT = /^\s*(stop|baja|no\s+m[aá]s(\s+mensajes)?|cancelar\s+suscripci[oó]n)\s*[.!]?\s*$/i;
const OPT_IN = /^\s*alta\s*[.!]?\s*$/i;

export interface ConversationDeps {
  repo: Repo;
  agent: Agent;
  outbox: Outbox;
  queue: KeyedQueue;
  log: Logger;
  debounceMs: number;
  /** Opcionales: panel en vivo y alertas a asesores. */
  bus?: EventBus;
  alerts?: AlertDispatcher;
  panelUrl?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ConversationService {
  constructor(private readonly d: ConversationDeps) {}

  private alert(
    type: AlertPayload["type"],
    conversationId: number,
    extra: Pick<AlertPayload, "reason" | "lastMessage">,
  ): void {
    const { repo, alerts, panelUrl } = this.d;
    if (!alerts) return;
    const conv = repo.getConversation(conversationId);
    const customer = conv && repo.getCustomer(conv.customer_id);
    if (!conv || !customer) return;
    alerts.dispatch({
      type,
      conversationId,
      customerName: customer.name,
      waId: customer.wa_id,
      ...extra,
      panelUrl: panelUrl ? `${panelUrl}/?c=${conversationId}` : undefined,
    });
  }

  /** Parte rápida y síncrona: guarda el mensaje (una sola vez) y encola el procesamiento. */
  ingest(m: InboundMessage): void {
    const { repo, queue } = this.d;

    const stored = repo.db.transaction(() => {
      if (!repo.markProcessed(m.waMessageId)) return undefined; // duplicado: Meta reintenta entregas
      const customer = repo.upsertCustomer(m.from, m.name);
      const conversation = repo.getOrCreateConversation(customer.id);
      repo.addMessage({
        conversationId: conversation.id,
        direction: "in",
        author: "cliente",
        body: m.body,
        waMessageId: m.waMessageId,
      });
      return { customer, conversation };
    })();
    if (!stored) return;

    const { customer, conversation } = stored;
    this.d.bus?.emit({ type: "message", conversationId: conversation.id });
    if (OPT_OUT.test(m.body)) {
      repo.setOptedOut(customer.id, true);
      this.d.outbox.enqueue({
        conversationId: conversation.id,
        toWaId: customer.wa_id,
        body: OPT_OUT_TEXT,
        author: "bot",
      });
      return;
    }
    if (OPT_IN.test(m.body) && customer.opted_out) repo.setOptedOut(customer.id, false);

    // Si una persona atiende (o la conversación está escalada), el cliente que escribe debe ser visto.
    if (conversation.mode !== "bot" && !customer.opted_out) {
      this.alert("mensaje_pendiente", conversation.id, { lastMessage: m.body });
    }

    queue.enqueue(`conv:${conversation.id}`, () => this.process(conversation.id));
  }

  async process(conversationId: number): Promise<void> {
    const { repo, agent, outbox, log } = this.d;
    // Pequeña espera para agrupar ráfagas de mensajes cortos en una sola respuesta.
    if (this.d.debounceMs > 0) await sleep(this.d.debounceMs);

    const conversation = repo.getConversation(conversationId);
    if (!conversation) return;
    const customer = repo.getCustomer(conversation.customer_id)!;
    if (conversation.mode !== "bot" || customer.opted_out) return;

    let text: string;
    let handoff = false;
    let reason: string | undefined;
    try {
      const result = await agent.reply(conversationId);
      if (result.skipped) return;
      text = result.text;
      handoff = result.handoff;
      reason = result.handoffReason;
      if (result.toolsUsed.includes("create_quote_request")) {
        this.alert("cotizacion", conversationId, {
          reason: repo.latestQuoteSummary(customer.id) ?? "El cliente pidió una cotización",
          lastMessage: repo.lastMessage(conversationId)?.body,
        });
      }
    } catch (err) {
      // Modelo caído o error de red: nunca dejar al cliente en silencio, y que una persona lo vea.
      log.error({ err: (err as Error).message, conversationId }, "falló el agente; se escala a humano");
      repo.setMode(conversationId, "escalado");
      repo.addMessage({
        conversationId,
        direction: "out",
        author: "nota",
        body: `Escalado a humano: error del modelo (${(err as Error).message.slice(0, 200)})`,
        status: "internal",
      });
      text = FALLBACK_TEXT;
      handoff = true;
      reason = `Error del modelo: ${(err as Error).message.slice(0, 200)}`;
    }

    if (handoff) {
      this.alert("escalado", conversationId, {
        reason: reason ?? "El asistente escaló la conversación",
        lastMessage: repo.lastMessage(conversationId)?.body,
      });
      this.d.bus?.emit({ type: "conversation", conversationId });
    }

    // Si una persona tomó el control mientras el modelo pensaba, se descarta la respuesta del bot.
    const latest = repo.getConversation(conversationId)!;
    if (!handoff && latest.mode !== "bot") return;

    outbox.enqueue({ conversationId, toWaId: customer.wa_id, body: text, author: "bot" });
    this.d.bus?.emit({ type: "message", conversationId });
  }
}

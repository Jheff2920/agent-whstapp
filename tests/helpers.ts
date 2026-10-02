import pino from "pino";
import { Agent } from "../src/agent/agent.js";
import { loadConfig, type Config } from "../src/config.js";
import { ConversationService } from "../src/conversation.js";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";
import { KnowledgeStore } from "../src/knowledge/loader.js";
import type { CompleteRequest, CompleteResponse, LLMProvider } from "../src/llm/types.js";
import { Outbox, type SendRequest, type Sender } from "../src/outbox.js";
import { EventBus } from "../src/events.js";
import { AlertDispatcher, type AlertPayload, type Notifier } from "../src/notify.js";
import { KeyedQueue } from "../src/queue.js";
import { buildApp } from "../src/server.js";

export const FIXTURE_KNOWLEDGE = new URL("./fixtures/knowledge", import.meta.url).pathname;

export type Step = CompleteResponse | ((req: CompleteRequest, call: number) => CompleteResponse | Promise<CompleteResponse>);

/** Proveedor de lenguaje guionado: devuelve cada paso en orden y registra las peticiones. */
export class FakeProvider implements LLMProvider {
  readonly name = "ollama" as const;
  readonly model = "fake";
  calls: CompleteRequest[] = [];
  constructor(private steps: Step[]) {}

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.calls.push({ ...req, turns: [...req.turns] });
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)]!;
    return typeof step === "function" ? step(req, this.calls.length) : step;
  }

  async generateObject(): Promise<never> {
    throw new Error("no usado en estos tests");
  }
}

export const say = (text: string): CompleteResponse => ({ text, toolCalls: [] });
export const callTool = (name: string, input: unknown, id = `c_${name}`): CompleteResponse => ({
  text: "",
  toolCalls: [{ id, name, input }],
});

export class CaptureSender implements Sender {
  sent: SendRequest[] = [];
  failTimes = 0;
  async send(req: SendRequest) {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error("n8n caído");
    }
    this.sent.push(req);
    return { waMessageId: `wamid.out.${req.outboxId}` };
  }
}

export class CaptureNotifier implements Notifier {
  alerts: AlertPayload[] = [];
  async notify(alert: AlertPayload) {
    this.alerts.push(alert);
  }
}

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    DEBOUNCE_MS: "0",
    INTERNAL_TOKEN: "tok",
    WA_APP_SECRET: "secreto",
    KNOWLEDGE_DIR: FIXTURE_KNOWLEDGE,
    ...over,
  } as NodeJS.ProcessEnv);
}

export function setup(steps: Step[], over: Record<string, string> = {}) {
  const cfg = testConfig(over);
  const log = pino({ level: "silent" });
  const repo = new Repo(openDb(":memory:"));
  const provider = new FakeProvider(steps);
  const knowledge = new KnowledgeStore(cfg.knowledgeDir);
  const agent = new Agent({ provider, repo, knowledge, cfg });
  const sender = new CaptureSender();
  const outbox = new Outbox(repo, sender, log);
  const queue = new KeyedQueue();
  const bus = new EventBus();
  const notifier = new CaptureNotifier();
  const alerts = new AlertDispatcher(notifier, log);
  const conversations = new ConversationService({
    repo, agent, outbox, queue, log, debounceMs: 0, bus, alerts, panelUrl: "http://panel.test",
  });
  const app = buildApp({ cfg, repo, conversations, log });
  return { cfg, log, repo, provider, knowledge, agent, sender, outbox, queue, conversations, app, bus, notifier, alerts };
}

export function metaPayload(id: string, from: string, text: string, name = "Cliente Test") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: from, profile: { name } }],
              messages: [{ id, from, timestamp: "1700000000", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

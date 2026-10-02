import pino from "pino";
import { Agent } from "./agent/agent.js";
import { loadConfig } from "./config.js";
import { ConversationService } from "./conversation.js";
import { openDb } from "./db/db.js";
import { Repo } from "./db/repos.js";
import { assertKnowledgeReady, KnowledgeStore } from "./knowledge/loader.js";
import { createProvider } from "./llm/index.js";
import { HttpSender, LogSender, Outbox } from "./outbox.js";
import { KeyedQueue } from "./queue.js";
import { buildApp } from "./server.js";

const cfg = loadConfig();
const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(cfg.nodeEnv === "production" ? {} : { transport: { target: "pino-pretty" } }),
});

const db = openDb(cfg.dbPath);
const repo = new Repo(db);
const knowledge = new KnowledgeStore(cfg.knowledgeDir);
const k = knowledge.get();
assertKnowledgeReady(k, cfg.nodeEnv);
if (k.pending.length) log.warn({ pending: k.pending }, "conocimiento del negocio incompleto (knowledge/)");

const provider = createProvider(cfg);
log.info({ provider: provider.name, model: provider.model }, "modelo de lenguaje configurado");

const sender = cfg.n8nSendUrl ? new HttpSender(cfg.n8nSendUrl, cfg.internalToken) : new LogSender(log);
if (!cfg.n8nSendUrl) log.warn("N8N_SEND_URL vacío: los mensajes salientes solo se registran en el log");

const outbox = new Outbox(repo, sender, log);
const queue = new KeyedQueue((err) => log.error({ err }, "error procesando conversación"));
const agent = new Agent({
  provider,
  repo,
  knowledge,
  cfg,
  onTool: (name, input, _out, isError) => log.debug({ name, input, isError }, "tool"),
});
const conversations = new ConversationService({ repo, agent, outbox, queue, log, debounceMs: cfg.debounceMs });

const app = buildApp({ cfg, repo, conversations, log });
outbox.start();
await app.listen({ port: cfg.port, host: "0.0.0.0" });

const shutdown = async (signal: string) => {
  log.info({ signal }, "apagando");
  outbox.stop();
  await app.close();
  await queue.idle();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

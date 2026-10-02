import pino from "pino";
import { Agent } from "./agent/agent.js";
import { loadConfig } from "./config.js";
import { ConversationService } from "./conversation.js";
import { openDb } from "./db/db.js";
import { Repo } from "./db/repos.js";
import { assertKnowledgeReady, KnowledgeStore } from "./knowledge/loader.js";
import { createProvider } from "./llm/index.js";
import { EventBus } from "./events.js";
import { AlertDispatcher, selectNotifier } from "./notify.js";
import { HttpSender, LogSender, Outbox } from "./outbox.js";
import { Auth } from "./panel/auth.js";
import { buildPanelApp } from "./panel/server.js";
import { KeyedQueue } from "./queue.js";
import { CloudApiSender } from "./whatsapp/cloud.js";
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

// Envío: directo por la Cloud API de Meta, o vía n8n, o solo log (desarrollo)
const sendMode = cfg.waAccessToken ? "directo" : cfg.n8nSendUrl ? "n8n" : "log";
const sender =
  sendMode === "directo"
    ? new CloudApiSender({
        accessToken: cfg.waAccessToken,
        phoneNumberId: cfg.waPhoneNumberId,
        graphVersion: cfg.waGraphVersion,
        baseUrl: cfg.waGraphBaseUrl,
      })
    : sendMode === "n8n"
      ? new HttpSender(cfg.n8nSendUrl, cfg.internalToken)
      : new LogSender(log);
log.info({ sendMode }, "envío a WhatsApp");
if (sendMode === "log") log.warn("Sin WA_ACCESS_TOKEN ni N8N_SEND_URL: los mensajes salientes solo se registran en el log");
if (sendMode === "directo" && !cfg.waPhoneNumberId) log.warn("WA_PHONE_NUMBER_ID vacío: el envío directo fallará");

const bus = new EventBus();
const outbox = new Outbox(repo, sender, log, {
  onChange: (messageId) => {
    const conversationId = repo.conversationIdOfMessage(messageId);
    if (conversationId !== undefined) bus.emit({ type: "outbox", conversationId });
  },
});
const { notifier, channel: alertChannel } = selectNotifier(cfg);
const alerts = new AlertDispatcher(notifier, log);
if (alertChannel === "none") log.warn("Sin alertas: define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID (o ALERT_URL de n8n) para avisar a los asesores");
else log.info({ alertChannel }, "alertas a asesores");
const queue = new KeyedQueue((err) => log.error({ err }, "error procesando conversación"));
const agent = new Agent({
  provider,
  repo,
  knowledge,
  cfg,
  onTool: (name, input, _out, isError) => log.debug({ name, input, isError }, "tool"),
});
const conversations = new ConversationService({
  repo,
  agent,
  outbox,
  queue,
  log,
  debounceMs: cfg.debounceMs,
  bus,
  alerts,
  panelUrl: cfg.panelUrl || undefined,
});

// Puerto público (túnel): solo /api/inbound y /health. El panel va aparte, en PANEL_PORT.
const app = buildApp({ cfg, repo, conversations, log });
const auth = new Auth({
  password: cfg.adminPassword,
  passwordHash: cfg.adminPasswordHash,
  secret: cfg.sessionSecret,
  secure: cfg.cookieSecure,
});
if (!auth.configured) log.warn("Panel sin contraseña: define ADMIN_PASSWORD y SESSION_SECRET para poder iniciar sesión");
const panel = await buildPanelApp({
  cfg,
  repo,
  outbox,
  bus,
  auth,
  log,
  info: {
    provider: provider.name,
    model: provider.model,
    sendConfigured: sendMode !== "log",
    alertChannel,
    knowledgePending: () => knowledge.get().pending,
  },
});

outbox.start();
await app.listen({ port: cfg.port, host: "0.0.0.0" });
await panel.listen({ port: cfg.panelPort, host: cfg.panelHost });
log.info(`Panel: http://${cfg.panelHost === "0.0.0.0" ? "localhost" : cfg.panelHost}:${cfg.panelPort}`);

const shutdown = async (signal: string) => {
  log.info({ signal }, "apagando");
  outbox.stop();
  await app.close();
  await panel.close();
  await queue.idle();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

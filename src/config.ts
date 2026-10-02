import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .transform((v) => (v === "" ? undefined : v === "true" || v === "1"));

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z.string().default("development"),
  TIMEZONE: z.string().default("America/Lima"),
  DB_PATH: z.string().default("./data/agent.db"),
  KNOWLEDGE_DIR: z.string().default("./knowledge"),

  LLM_PROVIDER: z.enum(["ollama", "anthropic"]).default("ollama"),
  LLM_MODEL: z.string().optional(),
  LEARNING_PROVIDER: z.enum(["ollama", "anthropic", ""]).optional(),

  OLLAMA_URL: z.string().default("http://127.0.0.1:11434"),
  OLLAMA_THINK: bool.optional(),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().default(180_000),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  ANTHROPIC_FALLBACKS: bool.optional(),

  INTERNAL_TOKEN: z.string().default(""),
  WA_APP_SECRET: z.string().default(""),
  N8N_SEND_URL: z.string().default(""),

  // Envío y recepción directos con la Cloud API de Meta (sin n8n)
  WA_ACCESS_TOKEN: z.string().default(""),
  WA_PHONE_NUMBER_ID: z.string().default(""),
  WA_VERIFY_TOKEN: z.string().default(""),
  WA_GRAPH_VERSION: z.string().default("v23.0"),
  WA_GRAPH_BASE_URL: z.string().default("https://graph.facebook.com"),

  // Alertas a asesores por Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),

  ALERT_URL: z.string().default(""),
  PANEL_URL: z.string().default(""),
  PANEL_PORT: z.coerce.number().int().default(3001),
  PANEL_HOST: z.string().default("127.0.0.1"),
  ADMIN_PASSWORD: z.string().default(""),
  ADMIN_PASSWORD_HASH: z.string().default(""),
  SESSION_SECRET: z.string().default(""),
  COOKIE_SECURE: bool.optional(),

  HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
  MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(6),
  DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(1500),
});

export type Config = {
  port: number;
  nodeEnv: string;
  timezone: string;
  dbPath: string;
  knowledgeDir: string;
  llmProvider: "ollama" | "anthropic";
  llmModel?: string;
  learningProvider: "ollama" | "anthropic";
  ollamaUrl: string;
  ollamaThink?: boolean;
  ollamaTimeoutMs: number;
  anthropicApiKey?: string;
  anthropicEffort: "low" | "medium" | "high";
  anthropicFallbacks: boolean;
  internalToken: string;
  waAppSecret: string;
  n8nSendUrl: string;
  waAccessToken: string;
  waPhoneNumberId: string;
  waVerifyToken: string;
  waGraphVersion: string;
  waGraphBaseUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  alertUrl: string;
  panelUrl: string;
  panelPort: number;
  panelHost: string;
  adminPassword: string;
  adminPasswordHash: string;
  sessionSecret: string;
  cookieSecure: boolean;
  historyLimit: number;
  maxToolIterations: number;
  debounceMs: number;
};

export const DEFAULT_MODELS = {
  ollama: "qwen2.5:7b-instruct",
  anthropic: "claude-opus-5-5",
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = schema.parse(env);
  const cfg: Config = {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    timezone: e.TIMEZONE,
    dbPath: e.DB_PATH,
    knowledgeDir: e.KNOWLEDGE_DIR,
    llmProvider: e.LLM_PROVIDER,
    llmModel: e.LLM_MODEL || undefined,
    learningProvider: e.LEARNING_PROVIDER || e.LLM_PROVIDER,
    ollamaUrl: e.OLLAMA_URL,
    ollamaThink: e.OLLAMA_THINK,
    ollamaTimeoutMs: e.OLLAMA_TIMEOUT_MS,
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    anthropicEffort: e.ANTHROPIC_EFFORT,
    anthropicFallbacks: e.ANTHROPIC_FALLBACKS ?? true,
    internalToken: e.INTERNAL_TOKEN,
    waAppSecret: e.WA_APP_SECRET,
    n8nSendUrl: e.N8N_SEND_URL,
    waAccessToken: e.WA_ACCESS_TOKEN,
    waPhoneNumberId: e.WA_PHONE_NUMBER_ID,
    waVerifyToken: e.WA_VERIFY_TOKEN,
    waGraphVersion: e.WA_GRAPH_VERSION,
    waGraphBaseUrl: e.WA_GRAPH_BASE_URL.replace(/\/$/, ""),
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    alertUrl: e.ALERT_URL,
    panelUrl: e.PANEL_URL.replace(/\/$/, ""),
    panelPort: e.PANEL_PORT,
    panelHost: e.PANEL_HOST,
    adminPassword: e.ADMIN_PASSWORD,
    adminPasswordHash: e.ADMIN_PASSWORD_HASH,
    sessionSecret: e.SESSION_SECRET,
    cookieSecure: e.COOKIE_SECURE ?? false,
    historyLimit: e.HISTORY_LIMIT,
    maxToolIterations: e.MAX_TOOL_ITERATIONS,
    debounceMs: e.DEBOUNCE_MS,
  };
  if (cfg.nodeEnv === "production") {
    if (!cfg.waAppSecret) {
      throw new Error("WA_APP_SECRET debe definirse en producción (valida la firma de Meta)");
    }
    if (cfg.waAccessToken) {
      // Modo directo: Meta llama a /webhook y el cerebro envía por la Graph API
      if (!cfg.waPhoneNumberId) throw new Error("WA_PHONE_NUMBER_ID debe definirse junto con WA_ACCESS_TOKEN");
      if (!cfg.waVerifyToken) throw new Error("WA_VERIFY_TOKEN debe definirse (lo usa Meta para verificar el webhook)");
    } else if (cfg.n8nSendUrl) {
      // Modo n8n
      if (!cfg.internalToken || cfg.internalToken === "cambia-esto") {
        throw new Error("INTERNAL_TOKEN debe definirse en producción cuando se usa n8n");
      }
    } else {
      throw new Error("Configura el envío a WhatsApp: WA_ACCESS_TOKEN (directo) o N8N_SEND_URL (n8n)");
    }
  }
  if (cfg.nodeEnv === "production") {
    if (!cfg.adminPasswordHash && cfg.adminPassword.length < 10) {
      throw new Error("Define ADMIN_PASSWORD_HASH (npm run hash-password) o un ADMIN_PASSWORD de 10+ caracteres");
    }
    if (cfg.sessionSecret.length < 32) throw new Error("SESSION_SECRET debe tener al menos 32 caracteres");
  }
  return cfg;
}

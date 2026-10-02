import type { Logger } from "pino";
import type { Config } from "./config.js";

export interface AlertPayload {
  type: "escalado" | "mensaje_pendiente" | "cotizacion";
  conversationId: number;
  customerName: string | null;
  waId: string;
  reason?: string;
  lastMessage?: string;
  panelUrl?: string;
}

export interface Notifier {
  notify(alert: AlertPayload): Promise<void>;
}

/** Envía la alerta al webhook de n8n, que la reenvía por correo (o el canal que se configure). */
export class HttpNotifier implements Notifier {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(alert: AlertPayload): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": this.token },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`n8n respondió ${res.status}`);
  }
}

const TYPE_LABEL: Record<AlertPayload["type"], string> = {
  escalado: "Conversación escalada",
  mensaje_pendiente: "Cliente esperando respuesta",
  cotizacion: "Solicitud de cotización",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Texto plano (sin Markdown) para que lo que escribió el cliente no pueda alterar el formato del aviso. */
export function formatAlertText(a: AlertPayload): string {
  return [
    TYPE_LABEL[a.type],
    `Cliente: ${a.customerName ?? "(sin nombre)"} (+${a.waId})`,
    `Motivo: ${clip(a.reason ?? "El cliente espera una respuesta de un asesor", 500)}`,
    `Último mensaje del cliente: ${clip(a.lastMessage ?? "-", 500)}`,
    a.panelUrl ? `Abrir la conversación: ${a.panelUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Avisa a un asesor por Telegram (bot creado con @BotFather). */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  async notify(alert: AlertPayload): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatAlertText(alert),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { description?: string };
      // el token no se incluye en el mensaje para que no termine en los logs
      throw new Error(`Telegram respondió ${res.status}${data.description ? `: ${data.description}` : ""}`);
    }
  }
}

/** Telegram si hay token y chat; si no, el webhook de n8n; si no, sin alertas. */
export function selectNotifier(
  cfg: Pick<Config, "telegramBotToken" | "telegramChatId" | "alertUrl" | "internalToken">,
): { notifier: Notifier; channel: "telegram" | "n8n" | "none" } {
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    return { notifier: new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatId), channel: "telegram" };
  }
  if (cfg.alertUrl) return { notifier: new HttpNotifier(cfg.alertUrl, cfg.internalToken), channel: "n8n" };
  return { notifier: new NoopNotifier(), channel: "none" };
}

export class NoopNotifier implements Notifier {
  async notify(): Promise<void> {}
}

const COOLDOWN_MS: Record<AlertPayload["type"], number> = {
  escalado: 60_000,
  cotizacion: 60_000,
  // un cliente impaciente puede escribir muchas veces: una alerta cada 10 min por conversación
  mensaje_pendiente: 10 * 60_000,
};

/** Dispara alertas sin bloquear la conversación y sin repetirlas en ráfaga. */
export class AlertDispatcher {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  dispatch(alert: AlertPayload): void {
    const key = `${alert.type}:${alert.conversationId}`;
    const t = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined && t - prev < COOLDOWN_MS[alert.type]) return;
    this.last.set(key, t);
    this.notifier.notify(alert).catch((err) => {
      this.last.delete(key); // que el próximo intento no quede bloqueado por una alerta que no salió
      this.log.warn({ err: (err as Error).message, type: alert.type }, "no se pudo enviar la alerta");
    });
  }
}

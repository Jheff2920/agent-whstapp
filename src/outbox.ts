import type { Logger } from "pino";
import type { OutboxRow, Repo } from "./db/repos.js";

export interface SendRequest {
  outboxId: number;
  messageId: number;
  to: string;
  text: string;
}

export interface Sender {
  send(req: SendRequest): Promise<{ waMessageId?: string }>;
}

/** Envía vía el webhook de n8n, que a su vez llama a la Graph API de WhatsApp. */
export class HttpSender implements Sender {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(req: SendRequest): Promise<{ waMessageId?: string }> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": this.token },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`n8n respondió ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { wa_message_id?: string };
    return { waMessageId: data.wa_message_id };
  }
}

/** Modo desarrollo: sin n8n, los mensajes solo se registran en el log. */
export class LogSender implements Sender {
  constructor(private readonly log: Logger) {}
  async send(req: SendRequest): Promise<{ waMessageId?: string }> {
    this.log.info({ to: req.to }, `[dev] mensaje saliente: ${req.text}`);
    return {};
  }
}

export interface OutboxOptions {
  maxAttempts?: number;
  now?: () => Date;
  /** Se llama cuando cambia el estado de un mensaje (enviado, reintento, fallido). */
  onChange?: (messageId: number) => void;
}

export class Outbox {
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private rerun = false;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly onChange?: (messageId: number) => void;

  constructor(
    private readonly repo: Repo,
    private readonly sender: Sender,
    private readonly log: Logger,
    opts: OutboxOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.now = opts.now ?? (() => new Date());
    this.onChange = opts.onChange;
  }

  enqueue(o: { conversationId: number; toWaId: string; body: string; author: "bot" | "humano" }) {
    const queued = this.repo.enqueueOutbound(o);
    void this.flush();
    return queued;
  }

  start(intervalMs = 3000): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
    void this.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Si ya hay un envío en curso, pide otra pasada y espera a que termine (nunca vuelve antes de tiempo). */
  flush(): Promise<void> {
    if (this.current) {
      this.rerun = true;
      return this.current;
    }
    this.current = this.run().finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  private async run(): Promise<void> {
    do {
      this.rerun = false;
      for (const row of this.repo.dueOutbox()) await this.deliver(row);
    } while (this.rerun);
  }

  private async deliver(row: OutboxRow): Promise<void> {
    if (!this.repo.windowOpenForMessage(row.message_id, this.now())) {
      this.repo.markOutboxFailed(row, "fuera de la ventana de 24 h de WhatsApp: requiere plantilla aprobada");
      this.log.warn({ outboxId: row.id }, "mensaje fuera de la ventana de 24 h");
      this.onChange?.(row.message_id);
      return;
    }
    try {
      const { waMessageId } = await this.sender.send({
        outboxId: row.id,
        messageId: row.message_id,
        to: row.to_wa_id,
        text: row.body,
      });
      this.repo.markOutboxSent(row, waMessageId ?? null);
      this.onChange?.(row.message_id);
    } catch (err) {
      const message = (err as Error).message;
      if (row.attempts + 1 >= this.maxAttempts) {
        this.repo.markOutboxFailed(row, message);
        this.log.error({ outboxId: row.id, err: message }, "envío fallido definitivamente");
        this.onChange?.(row.message_id);
      } else {
        const delayMs = Math.min(5_000 * 2 ** row.attempts, 15 * 60_000);
        this.repo.markOutboxRetry(row, message, new Date(this.now().getTime() + delayMs).toISOString());
        this.log.warn({ outboxId: row.id, err: message, delayMs }, "envío falló, se reintentará");
      }
    }
  }
}

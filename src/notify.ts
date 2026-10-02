import type { Logger } from "pino";

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

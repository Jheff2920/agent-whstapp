import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Logger } from "pino";
import type { AppointmentRow, Repo } from "../db/repos.js";
import type { Sedes } from "../knowledge/sedes.js";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export function loadServiceAccount(file: string): ServiceAccount {
  let raw: Partial<ServiceAccount>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ServiceAccount>;
  } catch (err) {
    throw new Error(`No se pudo leer GOOGLE_SERVICE_ACCOUNT_FILE (${file}): ${(err as Error).message}`);
  }
  if (!raw.client_email || !raw.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_FILE no parece una clave de cuenta de servicio (faltan client_email o private_key)");
  }
  return { client_email: raw.client_email, private_key: raw.private_key };
}

const b64url = (x: Buffer | string) => Buffer.from(x).toString("base64url");
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

export interface GoogleEvent {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

export interface GoogleOptions {
  account: ServiceAccount;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  apiBase?: string;
  now?: () => number;
}

/** Cliente mínimo de Google Calendar con cuenta de servicio (JWT RS256 → token → REST). Sin dependencias. */
export class GoogleCalendarClient {
  private token?: { value: string; expiresAt: number };
  private readonly fetchImpl: typeof fetch;
  private readonly tokenUrl: string;
  private readonly apiBase: string;
  private readonly now: () => number;

  constructor(private readonly o: GoogleOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.tokenUrl = o.tokenUrl ?? "https://oauth2.googleapis.com/token";
    this.apiBase = (o.apiBase ?? "https://www.googleapis.com/calendar/v3").replace(/\/$/, "");
    this.now = o.now ?? Date.now;
  }

  private assertion(): string {
    const iat = Math.floor(this.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: this.o.account.client_email, scope: SCOPE, aud: this.tokenUrl, iat, exp: iat + 3600 }),
    );
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.o.account.private_key);
    return `${head}.${claims}.${b64url(sig)}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const res = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: this.assertion() }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !data.access_token) {
      throw new Error(`Google no entregó token (${res.status}): ${data.error_description ?? data.error ?? res.statusText}`);
    }
    this.token = { value: data.access_token, expiresAt: this.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  private async call(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok || okStatuses.includes(res.status)) return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) this.token = undefined;
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Google Calendar ${res.status}: ${data.error?.message ?? res.statusText}`);
  }

  async insert(calendarId: string, ev: GoogleEvent): Promise<string> {
    const r = await this.call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, ev);
    return String(r.id);
  }

  async update(calendarId: string, eventId: string, ev: GoogleEvent): Promise<void> {
    await this.call("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, ev);
  }

  /** Borrar un evento que ya no existe (404/410) cuenta como éxito. */
  async remove(calendarId: string, eventId: string): Promise<void> {
    await this.call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, undefined, [404, 410]);
  }
}

export const MAX_SYNC_ATTEMPTS = 8;

/**
 * Copia las citas de la base de datos (que es la fuente de verdad) al calendario de Google de cada sede.
 * Si Google falla, la cita sigue confirmada; se reintenta y, tras varios fallos, se avisa a los asesores.
 */
export class GoogleSync {
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: Repo,
    private readonly client: GoogleCalendarClient,
    private readonly getSedes: () => Sedes | undefined,
    private readonly log: Logger,
    private readonly onGiveUp?: (a: AppointmentRow, error: string) => void,
    private readonly onSynced?: () => void,
  ) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();
    void this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  run(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private body(a: AppointmentRow, tz: string, sedeName: string): GoogleEvent {
    const phone = this.repo.getCustomer(a.customer_id)?.wa_id;
    return {
      summary: `Visita: ${a.contact_name} (${sedeName})`,
      description: [
        a.purpose ? `Motivo: ${a.purpose}` : "",
        phone ? `WhatsApp: +${phone}` : "",
        `Cita #${a.id} (${a.source === "bot" ? "agendada por el asistente de WhatsApp" : "agendada desde el panel"})`,
      ]
        .filter(Boolean)
        .join("\n"),
      start: { dateTime: a.starts_at, timeZone: tz },
      end: { dateTime: a.ends_at, timeZone: tz },
    };
  }

  private async pass(): Promise<void> {
    const sedes = this.getSedes();
    if (!sedes) return;
    for (const a of this.repo.appointmentsToSync()) {
      const sede = sedes.sedes.find((x) => x.id === a.sede);
      if (!sede?.calendar_id) {
        this.repo.updateAppointment(a.id, { googleSync: "no_aplica" });
        continue;
      }
      try {
        if (a.status !== "confirmada") {
          if (a.google_event_id) await this.client.remove(sede.calendar_id, a.google_event_id);
          this.repo.updateAppointment(a.id, { googleSync: "ok", googleError: null });
        } else if (a.google_event_id) {
          await this.client.update(sede.calendar_id, a.google_event_id, this.body(a, sedes.zona_horaria, sede.nombre));
          this.repo.updateAppointment(a.id, { googleSync: "ok", googleError: null });
        } else {
          const id = await this.client.insert(sede.calendar_id, this.body(a, sedes.zona_horaria, sede.nombre));
          this.repo.updateAppointment(a.id, { googleEventId: id, googleSync: "ok", googleError: null });
        }
        this.onSynced?.();
      } catch (err) {
        const message = (err as Error).message;
        const attempts = a.google_attempts + 1;
        this.repo.updateAppointment(a.id, { googleSync: "error", googleError: message, googleAttempts: attempts });
        this.log.warn({ appointment: a.id, attempts, err: message }, "no se pudo sincronizar la cita con Google Calendar");
        if (attempts >= MAX_SYNC_ATTEMPTS) this.onGiveUp?.(a, message);
        this.onSynced?.();
      }
    }
  }
}

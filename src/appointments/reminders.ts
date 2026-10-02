import type { Logger } from "pino";
import type { AppointmentRow, Repo } from "../db/repos.js";
import type { Outbox, WaTemplate } from "../outbox.js";
import type { AppointmentService } from "./service.js";
import { localYmd, whenLabel, zonedToUtc } from "./time.js";

export interface ReminderOptions {
  /** Cuánto antes de la cita se avisa (por defecto 3 h). */
  leadMin?: number;
  /** Nunca se envía antes de esta hora local (por defecto 08:00): nadie quiere un aviso de madrugada. */
  notBefore?: string;
  /** Plantilla aprobada por Meta para cuando la ventana de 24 h está cerrada. Variables: nombre, sede, día y hora, dirección. */
  templateName?: string;
  templateLang?: string;
  timezone: string;
}

const DAY = 24 * 60 * 60_000;

/** Meta no admite saltos de línea, tabulaciones ni más de 4 espacios seguidos en las variables de una plantilla. */
const cleanParam = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200) || "-";

/**
 * Envía un recordatorio por cita. Con la ventana de 24 h abierta va como texto libre; si ya se cerró, solo
 * Meta permite una plantilla aprobada: sin ella el aviso no sale y queda anotado en la conversación.
 */
export class ReminderScheduler {
  private timer?: NodeJS.Timeout;
  private readonly lead: number;

  constructor(
    private readonly repo: Repo,
    private readonly outbox: Outbox,
    private readonly appointments: AppointmentService,
    private readonly log: Logger,
    private readonly o: ReminderOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lead = (o.leadMin ?? 180) * 60_000;
  }

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Instante en que corresponde avisar de esta cita. */
  sendAt(a: AppointmentRow): Date {
    const start = new Date(a.starts_at);
    const floor = zonedToUtc(localYmd(start, this.o.timezone), this.o.notBefore ?? "08:00", this.o.timezone);
    return new Date(Math.max(start.getTime() - this.lead, floor.getTime()));
  }

  tick(): number {
    const now = this.now();
    let sent = 0;
    for (const a of this.repo.appointmentsForReminder(now.toISOString(), new Date(now.getTime() + DAY).toISOString())) {
      const at = this.sendAt(a);
      if (at.getTime() > now.getTime()) continue;
      try {
        if (this.remind(a, now)) sent++;
      } catch (err) {
        this.log.error({ appointment: a.id, err: (err as Error).message }, "no se pudo preparar el recordatorio");
      }
    }
    return sent;
  }

  private remind(a: AppointmentRow, now: Date): boolean {
    const done = () => this.repo.updateAppointment(a.id, { reminderSentAt: now.toISOString() });
    // Citas tomadas poco antes de la hora del aviso: el cliente acaba de recibir la confirmación, no hace falta repetirla
    if (this.sendAt(a).getTime() <= new Date(a.created_at).getTime() + 30 * 60_000) {
      done();
      return false;
    }

    const customer = this.repo.getCustomer(a.customer_id);
    if (!customer || customer.opted_out) {
      done();
      return false;
    }
    const conv = a.conversation_id ? this.repo.getConversation(a.conversation_id) : undefined;
    const conversation = conv ?? this.repo.getOrCreateConversation(customer.id);
    const open = conversation.last_customer_message_at
      ? now.getTime() - new Date(conversation.last_customer_message_at).getTime() < DAY
      : false;

    const first = a.contact_name.split(/\s+/)[0] ?? a.contact_name;
    const sede = this.appointments.sedes().find((x) => x.id === a.sede);
    const text = `Hola ${first}, te recordamos tu cita en Red Soluciones: ${this.appointments.describe(a)}. Si no puedes asistir, respóndenos por aquí y la reprogramamos.`;

    let template: WaTemplate | undefined;
    if (!open) {
      if (!this.o.templateName) {
        this.repo.addMessage({
          conversationId: conversation.id,
          direction: "out",
          author: "nota",
          body: `Recordatorio de la cita #${a.id} no enviado: pasaron más de 24 h desde el último mensaje del cliente y no hay plantilla configurada (WA_REMINDER_TEMPLATE).`,
          status: "internal",
        });
        this.log.warn({ appointment: a.id }, "recordatorio omitido: ventana cerrada y sin plantilla");
        done();
        return false;
      }
      template = {
        name: this.o.templateName,
        lang: this.o.templateLang ?? "es",
        params: [first, sede?.nombre ?? a.sede, whenLabel(new Date(a.starts_at), this.o.timezone), sede?.direccion ?? ""].map(cleanParam),
      };
    }

    this.outbox.enqueue({ conversationId: conversation.id, toWaId: customer.wa_id, body: text, author: "bot", template });
    done();
    return true;
  }
}

import type { AppointmentRow, Repo } from "../db/repos.js";
import type { CitasConfig, Sede, Sedes } from "../knowledge/sedes.js";
import { dayWindows, isHoliday, slotsForDay } from "./slots.js";
import { addDays, dayLabel, dowOfYmd, isValidHm, isValidYmd, localHm, localYmd, whenLabel, zonedToUtc } from "./time.js";

/** `by`: quién lo hizo (el asistente por WhatsApp o una persona desde el panel). */
export type CitaEvent = { kind: "creada" | "cancelada" | "reprogramada"; appointment: AppointmentRow; sede: Sede; by: "bot" | "panel" };

export interface AppointmentHooks {
  onChange?: (e: CitaEvent) => void;
}

export type Result<T = AppointmentRow> = { ok: true; value: T; text: string } | { ok: false; code: string; text: string };

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const fail = (code: string, text: string): { ok: false; code: string; text: string } => ({ ok: false, code, text });

/**
 * Reglas de las citas en tienda. Los textos que devuelve se usan tal cual en la conversación, así que los
 * horarios y confirmaciones salen de código y no de lo que "calcule" el modelo.
 */
export class AppointmentService {
  constructor(
    private readonly repo: Repo,
    private readonly getSedes: () => Sedes | undefined,
    private readonly hooks: AppointmentHooks = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return Boolean(this.getSedes()?.citas);
  }

  private cfg(): { s: Sedes; c: CitasConfig } {
    const s = this.getSedes();
    if (!s?.citas) throw new Error("Las citas no están configuradas");
    return { s, c: s.citas };
  }

  sedes(): Sede[] {
    return this.getSedes()?.sedes ?? [];
  }

  sedeNames(): string {
    return (this.getSedes()?.sedes ?? []).map((x) => x.nombre).join(" y ");
  }

  resolveSede(ref: string): Sede | undefined {
    const r = norm(ref);
    if (!r) return undefined;
    return this.getSedes()?.sedes.find((x) => norm(x.id) === r || norm(x.nombre) === r || norm(x.nombre).includes(r) || r.includes(norm(x.nombre)));
  }

  private unknownSede(ref: string) {
    return fail("sede_invalida", `No existe la sede "${ref}". Las sedes son: ${this.sedeNames()}.`);
  }

  describe(a: Pick<AppointmentRow, "starts_at" | "sede">): string {
    const { s } = this.cfg();
    const sede = s.sedes.find((x) => x.id === a.sede);
    return `${whenLabel(new Date(a.starts_at), s.zona_horaria)} en ${sede?.nombre ?? a.sede} (${sede?.direccion ?? ""})`;
  }

  /** Horas de inicio libres de la sede ese día (respeta anticipación, horizonte, feriados y cupos). */
  freeStarts(sede: Sede, ymd: string, excludeId?: number): Date[] {
    const { s, c } = this.cfg();
    const now = this.now().getTime();
    const earliest = now + c.anticipacion_min * 60_000;
    const latest = now + c.horizonte_dias * 24 * 60 * 60_000;
    return slotsForDay(s, sede, ymd)
      .filter((sl) => sl.start.getTime() >= earliest && sl.start.getTime() <= latest)
      .filter((sl) => this.repo.countOverlapping(sede.id, sl.start.toISOString(), sl.end.toISOString(), excludeId) < c.cupos_por_franja)
      .map((sl) => sl.start);
  }

  private dayLine(sede: Sede, ymd: string): string | undefined {
    const { s } = this.cfg();
    const hours = this.freeStarts(sede, ymd).map((d) => localHm(d, s.zona_horaria));
    return hours.length ? `- ${dayLabel(ymd)} (${ymd}): ${hours.join(", ")}` : undefined;
  }

  /** Texto con los horarios libres. Sin fecha: los próximos 3 días con disponibilidad. */
  availability(sedeRef: string, fecha?: string): Result<string> {
    if (!this.enabled) return fail("desactivado", "Las citas no están disponibles por ahora.");
    const { s, c } = this.cfg();
    const sede = this.resolveSede(sedeRef);
    if (!sede) return this.unknownSede(sedeRef);

    if (fecha) {
      if (!isValidYmd(fecha)) return fail("fecha_invalida", `La fecha "${fecha}" no es válida; usa el formato AAAA-MM-DD.`);
      const today = localYmd(this.now(), s.zona_horaria);
      if (fecha < today) return fail("fecha_pasada", `${dayLabel(fecha)} ya pasó.`);
      if (isHoliday(s, fecha)) return fail("feriado", `El ${dayLabel(fecha)} es feriado y no se atiende. Propón otro día.`);
      if (dayWindows(sede, fecha).length === 0) {
        return fail("cerrado", `${sede.nombre} no atiende los ${dayLabel(fecha).split(" ")[0]}s. Propón otro día.`);
      }
      const line = this.dayLine(sede, fecha);
      if (!line) {
        return fail("sin_cupos", `No quedan horarios disponibles en ${sede.nombre} el ${dayLabel(fecha)} (considera la anticipación mínima y las citas ya tomadas). Prueba otro día.`);
      }
      return { ok: true, value: line, text: `Horarios libres en ${sede.nombre} (citas de ${c.duracion_min} min):\n${line}` };
    }

    const lines: string[] = [];
    const today = localYmd(this.now(), s.zona_horaria);
    for (let i = 0; i <= c.horizonte_dias && lines.length < 3; i++) {
      const l = this.dayLine(sede, addDays(today, i));
      if (l) lines.push(l);
    }
    if (!lines.length) return fail("sin_cupos", `No hay horarios libres en ${sede.nombre} en los próximos ${c.horizonte_dias} días.`);
    return { ok: true, value: lines.join("\n"), text: `Próximos horarios libres en ${sede.nombre} (citas de ${c.duracion_min} min):\n${lines.join("\n")}` };
  }

  /** Valida y devuelve el instante de inicio, o el motivo por el que no se puede. */
  private validateSlot(sede: Sede, fecha: string, hora: string, excludeId?: number): { ok: true; start: Date; end: Date } | ReturnType<typeof fail> {
    const { s, c } = this.cfg();
    if (!isValidYmd(fecha)) return fail("fecha_invalida", `La fecha "${fecha}" no es válida; usa el formato AAAA-MM-DD.`);
    if (!isValidHm(hora)) return fail("hora_invalida", `La hora "${hora}" no es válida; usa el formato HH:MM (24 h).`);
    if (isHoliday(s, fecha)) return fail("feriado", `El ${dayLabel(fecha)} es feriado y no se atiende.`);
    const start = zonedToUtc(fecha, hora, s.zona_horaria);
    const slot = slotsForDay(s, sede, fecha).find((sl) => sl.start.getTime() === start.getTime());
    if (!slot) {
      const hours = slotsForDay(s, sede, fecha).map((sl) => localHm(sl.start, s.zona_horaria));
      return fail("hora_fuera_de_horario", hours.length ? `A las ${hora} no hay citas en ${sede.nombre} ese día. Las citas son a las: ${hours.join(", ")}.` : `${sede.nombre} no atiende el ${dayLabel(fecha)}.`);
    }
    const now = this.now().getTime();
    if (start.getTime() < now + c.anticipacion_min * 60_000) {
      return fail("sin_anticipacion", `Las citas se reservan con al menos ${c.anticipacion_min} min de anticipación.`);
    }
    if (start.getTime() > now + c.horizonte_dias * 24 * 60 * 60_000) {
      return fail("muy_adelante", `Solo se puede reservar hasta ${c.horizonte_dias} días hacia adelante.`);
    }
    if (this.repo.countOverlapping(sede.id, slot.start.toISOString(), slot.end.toISOString(), excludeId) >= c.cupos_por_franja) {
      const alt = this.dayLine(sede, fecha);
      return fail("sin_cupo", `Esa hora ya está completa en ${sede.nombre}.${alt ? ` Quedan estos horarios:\n${alt}` : " No quedan horarios ese día."}`);
    }
    return { ok: true, start: slot.start, end: slot.end };
  }

  book(a: {
    customerId: number;
    conversationId?: number | null;
    sede: string;
    fecha: string;
    hora: string;
    nombre: string;
    motivo?: string;
    source?: "bot" | "panel";
  }): Result {
    if (!this.enabled) return fail("desactivado", "Las citas no están disponibles por ahora.");
    const { c } = this.cfg();
    const sede = this.resolveSede(a.sede);
    if (!sede) return this.unknownSede(a.sede);
    const name = a.nombre.trim();
    if (name.length < 2) return fail("falta_nombre", "Falta el nombre de la persona que vendrá.");

    let result: Result;
    try {
      // un solo proceso y transacción síncrona: la comprobación de cupo y el alta no se pueden intercalar
      result = this.repo.db.transaction((): Result => {
        const upcoming = this.repo.upcomingAppointments(a.customerId, this.now().toISOString());
        if ((a.source ?? "bot") === "bot" && upcoming.length >= c.max_por_cliente) {
          return fail(
            "limite_cliente",
            `El cliente ya tiene ${upcoming.length} citas próximas (máximo ${c.max_por_cliente}). Si necesita otra, que cancele o cambie una existente: ${upcoming.map((u) => `#${u.id} ${this.describe(u)}`).join("; ")}.`,
          );
        }
        const v = this.validateSlot(sede, a.fecha, a.hora);
        if (!v.ok) return v;
        const appt = this.repo.insertAppointment({
          customerId: a.customerId,
          conversationId: a.conversationId,
          sede: sede.id,
          startsAt: v.start.toISOString(),
          endsAt: v.end.toISOString(),
          contactName: name,
          purpose: a.motivo?.trim() || null,
          source: a.source ?? "bot",
          googleSync: sede.calendar_id ? "pendiente" : "no_aplica",
        });
        return {
          ok: true,
          value: appt,
          text: `Cita confirmada #${appt.id}: ${this.describe(appt)}, a nombre de ${name}. Dura ${c.duracion_min} min.`,
        };
      })();
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) return fail("duplicada", "El cliente ya tiene una cita a esa misma hora en esa sede.");
      throw err;
    }
    if (result.ok) this.hooks.onChange?.({ kind: "creada", appointment: result.value, sede, by: a.source ?? "bot" });
    return result;
  }

  /** Citas próximas del cliente, ya redactadas para el prompt o para la herramienta. */
  customerUpcoming(customerId: number): AppointmentRow[] {
    return this.repo.upcomingAppointments(customerId, this.now().toISOString());
  }

  listText(customerId: number): string {
    const list = this.customerUpcoming(customerId);
    if (!list.length) return "El cliente no tiene citas próximas.";
    return list.map((u) => `#${u.id}: ${this.describe(u)}, a nombre de ${u.contact_name}`).join("\n");
  }

  private sedeOf(a: AppointmentRow): Sede {
    return this.cfg().s.sedes.find((x) => x.id === a.sede)!;
  }

  /** `customerId` restringe a las citas de ese cliente (el bot nunca toca citas ajenas). */
  cancel(id: number, opts: { customerId?: number } = {}): Result {
    if (!this.enabled) return fail("desactivado", "Las citas no están disponibles por ahora.");
    const appt = this.repo.getAppointment(id);
    if (!appt || (opts.customerId !== undefined && appt.customer_id !== opts.customerId)) {
      return fail("no_encontrada", `No existe la cita #${id} de este cliente.`);
    }
    if (appt.status !== "confirmada") return fail("no_vigente", `La cita #${id} ya no está vigente (${appt.status}).`);
    const sede = this.sedeOf(appt);
    this.repo.updateAppointment(id, {
      status: "cancelada",
      googleSync: sede?.calendar_id && appt.google_event_id ? "pendiente" : "no_aplica",
      googleAttempts: 0,
      googleError: null,
    });
    const updated = this.repo.getAppointment(id)!;
    this.hooks.onChange?.({ kind: "cancelada", appointment: updated, sede, by: opts.customerId !== undefined ? "bot" : "panel" });
    return { ok: true, value: updated, text: `Cita #${id} cancelada (era ${this.describe(appt)}).` };
  }

  /** Cambia fecha/hora dentro de la misma sede (para otra sede: cancelar y reservar de nuevo). */
  reschedule(id: number, a: { fecha: string; hora: string; customerId?: number }): Result {
    if (!this.enabled) return fail("desactivado", "Las citas no están disponibles por ahora.");
    const appt = this.repo.getAppointment(id);
    if (!appt || (a.customerId !== undefined && appt.customer_id !== a.customerId)) {
      return fail("no_encontrada", `No existe la cita #${id} de este cliente.`);
    }
    if (appt.status !== "confirmada") return fail("no_vigente", `La cita #${id} ya no está vigente (${appt.status}).`);
    const sede = this.sedeOf(appt);
    const { c } = this.cfg();
    const before = this.describe(appt);

    let result: Result;
    try {
      result = this.repo.db.transaction((): Result => {
        const v = this.validateSlot(sede, a.fecha, a.hora, id);
        if (!v.ok) return v;
        this.repo.updateAppointment(id, {
          startsAt: v.start.toISOString(),
          endsAt: v.end.toISOString(),
          googleSync: sede.calendar_id ? "pendiente" : "no_aplica",
          googleAttempts: 0,
          googleError: null,
          reminderSentAt: null,
        });
        const updated = this.repo.getAppointment(id)!;
        return { ok: true, value: updated, text: `Cita #${id} reprogramada: antes ${before}; ahora ${this.describe(updated)}. Dura ${c.duracion_min} min.` };
      })();
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) return fail("duplicada", "El cliente ya tiene una cita a esa misma hora en esa sede.");
      throw err;
    }
    if (result.ok) this.hooks.onChange?.({ kind: "reprogramada", appointment: result.value, sede, by: a.customerId !== undefined ? "bot" : "panel" });
    return result;
  }

  /** Horas libres (HH:MM) de una sede ese día, para el selector del panel. */
  freeHours(sedeRef: string, ymd: string, excludeId?: number): string[] {
    const sede = this.resolveSede(sedeRef);
    if (!sede || !this.enabled || !isValidYmd(ymd)) return [];
    const tz = this.cfg().s.zona_horaria;
    return this.freeStarts(sede, ymd, excludeId).map((d) => localHm(d, tz));
  }

  /** Marca una cita pasada como completada o como "no asistió". */
  markStatus(id: number, status: "completada" | "no_asistio"): Result {
    const appt = this.repo.getAppointment(id);
    if (!appt) return fail("no_encontrada", `No existe la cita #${id}.`);
    if (appt.status === "cancelada") return fail("no_vigente", `La cita #${id} está cancelada.`);
    this.repo.updateAppointment(id, { status });
    return { ok: true, value: this.repo.getAppointment(id)!, text: `Cita #${id} marcada como ${status === "completada" ? "completada" : "no asistió"}.` };
  }

  /** Vuelve a intentar la copia a Google Calendar (tras corregir permisos, por ejemplo). */
  retryGoogle(id: number): Result {
    const appt = this.repo.getAppointment(id);
    if (!appt) return fail("no_encontrada", `No existe la cita #${id}.`);
    const sede = this.cfg().s.sedes.find((x) => x.id === appt.sede);
    if (!sede?.calendar_id) return fail("sin_calendario", "Esta sede no tiene calendar_id en sedes.yml.");
    this.repo.updateAppointment(id, { googleSync: "pendiente", googleAttempts: 0, googleError: null });
    this.hooks.onChange?.({ kind: "reprogramada", appointment: this.repo.getAppointment(id)!, sede, by: "panel" });
    return { ok: true, value: this.repo.getAppointment(id)!, text: "Se reintentará la copia a Google Calendar." };
  }
}

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTools } from "../src/agent/tools.js";
import { buildSystem } from "../src/agent/prompt.js";
import { AppointmentService, type CitaEvent } from "../src/appointments/service.js";
import { holidayCoverageWarning, slotsForDay } from "../src/appointments/slots.js";
import { addDays, dayLabel, localHm, localYmd, whenLabel, zonedToUtc } from "../src/appointments/time.js";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";
import { parseSedes } from "../src/knowledge/sedes.js";
import { KnowledgeStore } from "../src/knowledge/loader.js";
import { FIXTURE_KNOWLEDGE } from "./helpers.js";

const REAL = parseSedes(fs.readFileSync(new URL("../knowledge/sedes.yml", import.meta.url), "utf8"));
const TZ = "America/Lima";
/** Lunes 5 de octubre de 2026, 09:00 en Lima. */
const MON_9AM = new Date("2026-10-05T14:00:00Z");

function make(opts: { now?: Date; events?: CitaEvent[] } = {}) {
  const repo = new Repo(openDb(":memory:"));
  let now = opts.now ?? MON_9AM;
  const svc = new AppointmentService(repo, () => REAL, { onChange: (e) => opts.events?.push(e) }, () => now);
  const customer = (n: number) => repo.upsertCustomer(`5199000000${n}`, `Cliente ${n}`);
  const conv = (id: number) => repo.getOrCreateConversation(id);
  return { repo, svc, customer, conv, setNow: (d: Date) => (now = d) };
}

const book = (svc: AppointmentService, customerId: number, over: Partial<Parameters<AppointmentService["book"]>[0]> = {}) =>
  svc.book({ customerId, sede: "cyberplaza", fecha: "2026-10-06", hora: "10:00", nombre: "Ana Torres", ...over });

describe("zona horaria de Lima", () => {
  it("convierte hora local a UTC y de vuelta", () => {
    expect(zonedToUtc("2026-10-06", "10:00", TZ).toISOString()).toBe("2026-10-06T15:00:00.000Z");
    expect(localYmd(new Date("2026-10-07T03:30:00Z"), TZ)).toBe("2026-10-06");
    expect(localHm(new Date("2026-10-06T15:00:00Z"), TZ)).toBe("10:00");
  });
  it("redacta fechas en español", () => {
    expect(dayLabel("2026-10-08")).toBe("jueves 8 de octubre");
    expect(whenLabel(new Date("2026-10-06T15:00:00Z"), TZ)).toBe("martes 6 de octubre a las 10:00");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("franjas", () => {
  const sede = (id: string) => REAL.sedes.find((s) => s.id === id)!;
  const hours = (id: string, ymd: string) => slotsForDay(REAL, sede(id), ymd).map((s) => localHm(s.start, TZ));

  it("cada hora dentro del horario de la sede", () => {
    expect(hours("cyberplaza", "2026-10-06")).toEqual(["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"]);
    expect(hours("san-isidro", "2026-10-06")).toHaveLength(9); // 09:00 a 17:00 (última termina 18:00)
    expect(hours("san-isidro", "2026-10-10")).toEqual(["09:00", "10:00", "11:00", "12:00"]); // sábado hasta 13:00
  });
  it("domingos y feriados no tienen franjas", () => {
    expect(hours("cyberplaza", "2026-10-11")).toEqual([]);
    expect(hours("cyberplaza", "2026-10-08")).toEqual([]); // Combate de Angamos
  });
  it("avisa si la lista de feriados no cubre el período reservable", () => {
    expect(holidayCoverageWarning(REAL, "2026-10-02")).toBeUndefined();
    expect(holidayCoverageWarning(REAL, "2027-12-20")).toContain("termina el 2027-12-25");
    expect(holidayCoverageWarning({ ...REAL, feriados: [] }, "2026-10-02")).toContain("no tiene feriados");
  });
});

describe("disponibilidad", () => {
  it("lista los próximos días con cupo; reconoce la sede por nombre aproximado", () => {
    const { svc } = make();
    const r = svc.availability("san isidro");
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Próximos horarios libres en San Isidro");
    // lunes 5 a las 9:00 → la franja de las 9:00 ya no cumple 1 h de anticipación
    expect(r.text).toContain("lunes 5 de octubre (2026-10-05): 10:00, 11:00");
    expect(r.text).not.toContain("lunes 5 de octubre (2026-10-05): 09:00");
    expect(r.text).toContain("martes 6 de octubre");
    expect(r.text).toContain("miércoles 7 de octubre");
    expect(r.text).not.toContain("jueves 8"); // feriado
  });
  it("rechaza feriado, domingo, fecha pasada, formato y sede inexistente con mensajes claros", () => {
    const { svc } = make();
    expect(svc.availability("cyberplaza", "2026-10-08")).toMatchObject({ ok: false, code: "feriado" });
    expect(svc.availability("cyberplaza", "2026-10-11")).toMatchObject({ ok: false, code: "cerrado" });
    expect(svc.availability("cyberplaza", "2026-10-04")).toMatchObject({ ok: false, code: "fecha_pasada" });
    expect(svc.availability("cyberplaza", "mañana")).toMatchObject({ ok: false, code: "fecha_invalida" });
    const r = svc.availability("miraflores");
    expect(r).toMatchObject({ ok: false, code: "sede_invalida" });
    expect(r.text).toContain("Cyberplaza y San Isidro");
  });
});

describe("reservar", () => {
  it("confirma con texto determinista y guarda en UTC", () => {
    const { svc, customer } = make();
    const r = book(svc, customer(1).id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("martes 6 de octubre a las 10:00 en Cyberplaza");
    expect(r.text).toContain("Av. Garcilazo de la Vega 1348");
    expect(r.value.starts_at).toBe("2026-10-06T15:00:00.000Z");
    expect(r.value.ends_at).toBe("2026-10-06T16:00:00.000Z");
    expect(r.value.google_sync).toBe("no_aplica"); // sin calendar_id
  });

  it("exige 1 hora de anticipación", () => {
    const { svc, customer } = make({ now: new Date("2026-10-05T14:30:00Z") }); // 09:30 Lima
    expect(book(svc, customer(1).id, { fecha: "2026-10-05", hora: "10:00" })).toMatchObject({ ok: false, code: "sin_anticipacion" });
    expect(book(svc, customer(1).id, { fecha: "2026-10-05", hora: "11:00" }).ok).toBe(true); // 1 h 30 min
  });

  it("exactamente 60 min de anticipación sí se permite", () => {
    const { svc, customer } = make({ now: new Date("2026-10-05T15:00:00Z") }); // 10:00 Lima
    expect(book(svc, customer(1).id, { fecha: "2026-10-05", hora: "11:00" }).ok).toBe(true);
  });

  it("máximo 2 citas simultáneas por sede; la tercera recibe alternativas y la otra sede sigue libre", () => {
    const { svc, customer } = make();
    expect(book(svc, customer(1).id).ok).toBe(true);
    expect(book(svc, customer(2).id).ok).toBe(true);
    const third = book(svc, customer(3).id);
    expect(third).toMatchObject({ ok: false, code: "sin_cupo" });
    expect(third.text).toContain("ya está completa en Cyberplaza");
    expect(third.text).toContain("11:00");
    expect(third.text).not.toMatch(/martes 6 de octubre \(2026-10-06\): 10:00/);
    expect(book(svc, customer(3).id, { sede: "san-isidro" }).ok).toBe(true);
    // la hora siguiente no se ve afectada: las franjas se tocan pero no se cruzan
    expect(book(svc, customer(3).id, { hora: "11:00" }).ok).toBe(true);
  });

  it("rechaza fuera de horario, feriado, domingo, demasiado lejos y nombre vacío", () => {
    const { svc, customer } = make();
    const c = customer(1).id;
    expect(book(svc, c, { hora: "10:30" })).toMatchObject({ ok: false, code: "hora_fuera_de_horario" });
    expect(book(svc, c, { hora: "09:00" })).toMatchObject({ ok: false, code: "hora_fuera_de_horario" }); // Cyberplaza abre 10
    expect(book(svc, c, { hora: "19:00" })).toMatchObject({ ok: false, code: "hora_fuera_de_horario" });
    expect(book(svc, c, { fecha: "2026-10-08" })).toMatchObject({ ok: false, code: "feriado" });
    expect(book(svc, c, { fecha: "2026-10-11" })).toMatchObject({ ok: false, code: "hora_fuera_de_horario" });
    expect(book(svc, c, { fecha: "2026-12-01" })).toMatchObject({ ok: false, code: "muy_adelante" });
    expect(book(svc, c, { hora: "10h" })).toMatchObject({ ok: false, code: "hora_invalida" });
    expect(book(svc, c, { nombre: " " })).toMatchObject({ ok: false, code: "falta_nombre" });
  });

  it("el mismo cliente no puede duplicar la franja ni acaparar: máximo 2 próximas por el bot", () => {
    const { svc, customer } = make();
    const c = customer(1).id;
    expect(book(svc, c).ok).toBe(true);
    expect(book(svc, c)).toMatchObject({ ok: false, code: "duplicada" });
    expect(book(svc, c, { hora: "11:00" }).ok).toBe(true);
    const r = book(svc, c, { hora: "12:00" });
    expect(r).toMatchObject({ ok: false, code: "limite_cliente" });
    expect(r.text).toContain("máximo 2");
    // el personal desde el panel no tiene ese tope
    expect(book(svc, c, { hora: "12:00", source: "panel" }).ok).toBe(true);
  });

  it("20 intentos simultáneos sobre la misma franja nunca superan los cupos", async () => {
    const { svc, customer } = make();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => book(svc, customer(i).id))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
});

describe("cancelar y reprogramar", () => {
  it("cancelar libera el cupo; no se puede tocar la cita de otro cliente", () => {
    const { svc, customer } = make();
    const [a, b, c] = [customer(1).id, customer(2).id, customer(3).id];
    const first = book(svc, a);
    book(svc, b);
    expect(book(svc, c)).toMatchObject({ code: "sin_cupo" });
    if (!first.ok) throw new Error("no se reservó");
    expect(svc.cancel(first.value.id, { customerId: b })).toMatchObject({ ok: false, code: "no_encontrada" });
    const cancelled = svc.cancel(first.value.id, { customerId: a });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.text).toContain("cancelada");
    expect(svc.cancel(first.value.id, { customerId: a })).toMatchObject({ ok: false, code: "no_vigente" });
    expect(book(svc, c).ok).toBe(true);
  });

  it("reprogramar valida el nuevo horario y, si falla, la cita original queda intacta", () => {
    const { svc, repo, customer } = make();
    const [a, b, c] = [customer(1).id, customer(2).id, customer(3).id];
    const mine = book(svc, a);
    book(svc, b, { hora: "11:00" });
    book(svc, c, { hora: "11:00" });
    if (!mine.ok) throw new Error("no se reservó");
    const blocked = svc.reschedule(mine.value.id, { fecha: "2026-10-06", hora: "11:00", customerId: a });
    expect(blocked).toMatchObject({ ok: false, code: "sin_cupo" });
    expect(repo.getAppointment(mine.value.id)!.starts_at).toBe("2026-10-06T15:00:00.000Z");
    const ok = svc.reschedule(mine.value.id, { fecha: "2026-10-07", hora: "15:00", customerId: a });
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("antes martes 6 de octubre a las 10:00");
    expect(ok.text).toContain("ahora miércoles 7 de octubre a las 15:00");
    // moverla a su propia franja actual no choca consigo misma
    expect(svc.reschedule(mine.value.id, { fecha: "2026-10-07", hora: "15:00", customerId: a }).ok).toBe(true);
  });

  it("emite eventos con quién lo hizo", () => {
    const events: CitaEvent[] = [];
    const { svc, customer } = make({ events });
    const a = customer(1).id;
    const r = book(svc, a);
    if (!r.ok) throw new Error();
    svc.reschedule(r.value.id, { fecha: "2026-10-07", hora: "10:00", customerId: a });
    svc.cancel(r.value.id); // sin customerId = panel
    expect(events.map((e) => `${e.kind}:${e.by}`)).toEqual(["creada:bot", "reprogramada:bot", "cancelada:panel"]);
  });

  it("marca asistencia solo en citas no canceladas", () => {
    const { svc, customer } = make();
    const r = book(svc, customer(1).id);
    if (!r.ok) throw new Error();
    expect(svc.markStatus(r.value.id, "no_asistio").ok).toBe(true);
    svc.cancel(r.value.id); // ya no está vigente
    const r2 = book(svc, customer(2).id);
    if (!r2.ok) throw new Error();
    svc.cancel(r2.value.id);
    expect(svc.markStatus(r2.value.id, "completada")).toMatchObject({ ok: false, code: "no_vigente" });
  });
});

describe("herramientas del agente", () => {
  const toolsFor = (m: ReturnType<typeof make>, customerName = 1) => {
    const customer = m.customer(customerName);
    const conversation = m.conv(customer.id);
    const knowledge = new KnowledgeStore(FIXTURE_KNOWLEDGE).get();
    const tools = buildTools({ repo: m.repo, knowledge, conversationId: conversation.id, customerId: customer.id, state: { handoff: false }, appointments: m.svc });
    const run = (name: string, input: unknown) => tools.find((t) => t.name === name)!.run(input) as string;
    return { tools, run, customer };
  };

  it("sin citas activas no se ofrecen las herramientas de citas", () => {
    const repo = new Repo(openDb(":memory:"));
    const disabled = new AppointmentService(repo, () => undefined);
    const c = repo.upsertCustomer("51999", null);
    const names = buildTools({ repo, knowledge: new KnowledgeStore(FIXTURE_KNOWLEDGE).get(), conversationId: repo.getOrCreateConversation(c.id).id, customerId: c.id, state: { handoff: false }, appointments: disabled }).map((t) => t.name);
    expect(names).not.toContain("book_appointment");
    expect(names).toContain("handoff_to_human");
  });

  it("book_appointment no reserva sin confirmación explícita del cliente", () => {
    const m = make();
    const { run, customer } = toolsFor(m);
    const input = { sede: "cyberplaza", fecha: "2026-10-06", hora: "10:00", nombre: "Ana Torres" };
    expect(run("book_appointment", { ...input, cliente_confirmo: false })).toContain("No reservada");
    expect(m.repo.upcomingAppointments(customer.id, MON_9AM.toISOString())).toHaveLength(0);
  });

  it("flujo completo: disponibilidad, reserva, listado, cambio y cancelación; guarda etapa y nota", () => {
    const m = make();
    const { run, customer } = toolsFor(m);
    expect(run("check_availability", { sede: "Cyberplaza", fecha: "2026-10-06" })).toContain("10:00, 11:00");
    const booked = run("book_appointment", { sede: "Cyberplaza", fecha: "2026-10-06", hora: "10:00", nombre: "Ana Torres", motivo: "ver impresoras", cliente_confirmo: true });
    expect(booked).toContain("Cita confirmada #1");
    expect(m.repo.getCustomer(customer.id)!.stage).toBe("cita_agendada");
    expect(run("my_appointments", {})).toContain("#1: martes 6 de octubre a las 10:00 en Cyberplaza");
    expect(run("reschedule_appointment", { id: 1, fecha: "2026-10-06", hora: "12:00", cliente_confirmo: false })).toContain("No cambiada");
    expect(run("reschedule_appointment", { id: 1, fecha: "2026-10-06", hora: "12:00", cliente_confirmo: true })).toContain("reprogramada");
    expect(run("cancel_appointment", { id: 1 })).toContain("cancelada");
    expect(run("my_appointments", {})).toBe("El cliente no tiene citas próximas.");
    const notes = m.repo.allMessages(m.conv(customer.id).id).filter((x) => x.author === "nota");
    expect(notes.length).toBeGreaterThanOrEqual(3);
  });

  it("el modelo no puede cancelar la cita de otro cliente", () => {
    const m = make();
    const other = m.customer(2);
    const r = book(m.svc, other.id);
    if (!r.ok) throw new Error();
    const { run } = toolsFor(m, 1);
    expect(run("cancel_appointment", { id: r.value.id })).toContain("No se pudo cancelar (no_encontrada)");
    expect(m.repo.getAppointment(r.value.id)!.status).toBe("confirmada");
  });

  it("los errores vuelven al modelo con el motivo exacto", () => {
    const m = make();
    const { run } = toolsFor(m);
    expect(run("book_appointment", { sede: "cyberplaza", fecha: "2026-10-08", hora: "10:00", nombre: "Ana", cliente_confirmo: true })).toContain("(feriado)");
  });
});

describe("prompt de citas", () => {
  const k = new KnowledgeStore(FIXTURE_KNOWLEDGE).get();
  const customer = new Repo(openDb(":memory:")).upsertCustomer("51999", null);
  const ctx = { customer, facts: [], mode: "bot", now: MON_9AM, timezone: TZ };

  it("sin citas: el agente deriva a un asesor", () => {
    expect(buildSystem(k, ctx).stable).toContain("Por ahora no puedes agendar citas");
  });
  it("con citas: describe el proceso y lista las próximas del cliente en la parte volátil", () => {
    const { stable, volatile } = buildSystem(k, { ...ctx, appointments: { enabled: true, upcoming: ["#4 martes 6 de octubre a las 10:00 en Cyberplaza"] } });
    expect(stable).toContain("CITAS EN TIENDA");
    expect(stable).not.toContain("Por ahora no puedes agendar citas");
    expect(volatile).toContain("#4 martes 6 de octubre a las 10:00 en Cyberplaza");
    expect(stable).not.toContain("#4 martes"); // lo variable no ensucia el prompt cacheable
  });
  it("menciona los feriados en el prompt estable", () => {
    const withHolidays = { ...k, sedes: REAL };
    expect(buildSystem(withHolidays, ctx).stable).toContain("En feriados no se atiende");
  });
});

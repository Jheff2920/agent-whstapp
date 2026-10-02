import fs from "node:fs";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ReminderScheduler } from "../src/appointments/reminders.js";
import { AppointmentService } from "../src/appointments/service.js";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";
import { parseSedes } from "../src/knowledge/sedes.js";
import { Outbox } from "../src/outbox.js";
import { CloudApiSender } from "../src/whatsapp/cloud.js";
import { CaptureSender } from "./helpers.js";

const SEDES = parseSedes(fs.readFileSync(new URL("../knowledge/sedes.yml", import.meta.url), "utf8"));
const log = pino({ level: "silent" });
const TZ = "America/Lima";
const lima = (ymdHm: string) => new Date(`${ymdHm}:00-05:00`);

function make(opts: { templateName?: string } = {}) {
  const repo = new Repo(openDb(":memory:"));
  let clock = lima("2026-10-05T09:00"); // lunes
  const appointments = new AppointmentService(repo, () => SEDES, {}, () => clock);
  const sender = new CaptureSender();
  const outbox = new Outbox(repo, sender, log, { now: () => clock });
  const reminders = new ReminderScheduler(repo, outbox, appointments, log, { timezone: TZ, templateName: opts.templateName, templateLang: "es" }, () => clock);
  const customer = repo.upsertCustomer("51987654321", "Ana Torres");
  const conv = repo.getOrCreateConversation(customer.id);
  // el repositorio estampa la hora real: se fija a mano la del escenario simulado
  const touch = (at: Date) => {
    repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: "hola", createdAt: at.toISOString() });
    repo.db.prepare("UPDATE conversations SET last_customer_message_at = ? WHERE id = ?").run(at.toISOString(), conv.id);
  };
  const book = (fecha: string, hora: string, sede = "cyberplaza") => {
    const r = appointments.book({ customerId: customer.id, conversationId: conv.id, sede, fecha, hora, nombre: "Ana Torres" });
    if (!r.ok) throw new Error(r.text);
    repo.db.prepare("UPDATE appointments SET created_at = ? WHERE id = ?").run(clock.toISOString(), r.value.id);
    return r.value;
  };
  return { repo, reminders, outbox, sender, conv, customer, touch, book, setNow: (d: Date) => (clock = d) };
}

describe("recordatorios de citas", () => {
  it("avisa 3 h antes, una sola vez, con texto libre si la ventana de 24 h está abierta", async () => {
    const m = make();
    m.touch(lima("2026-10-05T09:00"));
    const a = m.book("2026-10-06", "15:00");
    m.touch(lima("2026-10-06T10:00")); // el cliente volvió a escribir esa mañana
    m.setNow(lima("2026-10-06T11:59"));
    expect(m.reminders.tick()).toBe(0);
    m.setNow(lima("2026-10-06T12:00"));
    expect(m.reminders.tick()).toBe(1);
    await m.outbox.flush();
    expect(m.sender.sent).toHaveLength(1);
    expect(m.sender.sent[0]!.template).toBeUndefined();
    expect(m.sender.sent[0]!.text).toContain("Hola Ana, te recordamos tu cita en Red Soluciones: martes 6 de octubre a las 15:00 en Cyberplaza");
    expect(m.repo.getAppointment(a.id)!.reminder_sent_at).not.toBeNull();
    m.setNow(lima("2026-10-06T12:05"));
    expect(m.reminders.tick()).toBe(0);
  });

  it("nunca avisa de madrugada: una cita de las 9:00 se avisa a las 8:00", () => {
    const m = make();
    m.touch(lima("2026-10-05T09:00"));
    m.book("2026-10-07", "09:00", "san-isidro");
    m.touch(lima("2026-10-06T10:00"));
    m.setNow(lima("2026-10-07T07:30"));
    expect(m.reminders.tick()).toBe(0);
    m.setNow(lima("2026-10-07T08:00"));
    expect(m.reminders.tick()).toBe(1);
  });

  it("con la ventana cerrada envía la plantilla aprobada con las variables en orden", async () => {
    const m = make({ templateName: "recordatorio_cita" });
    m.touch(lima("2026-10-03T10:00")); // hace más de 24 h al momento del aviso
    m.setNow(lima("2026-10-05T09:00"));
    m.book("2026-10-07", "15:00");
    m.setNow(lima("2026-10-07T12:00"));
    expect(m.reminders.tick()).toBe(1);
    await m.outbox.flush();
    expect(m.sender.sent[0]!.template).toEqual({
      name: "recordatorio_cita",
      lang: "es",
      params: ["Ana", "Cyberplaza", "miércoles 7 de octubre a las 15:00", "Cyberplaza – Av. Garcilazo de la Vega 1348. Stand SSA-153 / Módulo K-1041-B / Stand 2A-130"],
    });
  });

  it("con la ventana cerrada y sin plantilla no envía y deja una nota en la conversación", async () => {
    const m = make();
    m.touch(lima("2026-10-03T10:00"));
    m.book("2026-10-07", "15:00");
    m.setNow(lima("2026-10-07T12:00"));
    expect(m.reminders.tick()).toBe(0);
    await m.outbox.flush();
    expect(m.sender.sent).toHaveLength(0);
    const note = m.repo.allMessages(m.conv.id).find((x) => x.author === "nota")!;
    expect(note.body).toContain("WA_REMINDER_TEMPLATE");
    expect(m.reminders.tick()).toBe(0); // no insiste cada minuto
  });

  it("no avisa de citas canceladas ni a quien pidió la baja; reprogramar reinicia el aviso", () => {
    const m = make();
    m.touch(lima("2026-10-05T09:00"));
    const a = m.book("2026-10-06", "15:00");
    const b = m.book("2026-10-06", "16:00");
    const svc = new AppointmentService(m.repo, () => SEDES, {}, () => lima("2026-10-05T09:00"));
    svc.cancel(a.id);
    svc.reschedule(b.id, { fecha: "2026-10-07", hora: "10:00" });
    m.touch(lima("2026-10-06T12:00"));
    m.setNow(lima("2026-10-06T16:00"));
    expect(m.reminders.tick()).toBe(0);
    m.setNow(lima("2026-10-07T08:00"));
    expect(m.reminders.tick()).toBe(1);
    expect(m.repo.getAppointment(b.id)!.reminder_sent_at).not.toBeNull();
  });

  it("si la cita se tomó pocos minutos antes del aviso no repite la confirmación", () => {
    const m = make();
    m.touch(lima("2026-10-05T09:00"));
    m.setNow(lima("2026-10-05T12:00"));
    m.book("2026-10-05", "15:00"); // el aviso correspondería a las 12:00, justo al reservar
    expect(m.reminders.tick()).toBe(0);
  });

  it("quien pidió la baja no recibe recordatorios", () => {
    const m = make();
    m.touch(lima("2026-10-05T09:00"));
    m.book("2026-10-06", "15:00");
    m.repo.db.prepare("UPDATE customers SET opted_out = 1").run();
    m.setNow(lima("2026-10-06T12:00"));
    expect(m.reminders.tick()).toBe(0);
  });
});

describe("plantillas en la Cloud API", () => {
  it("envía type=template con idioma y variables; sin variables no manda componentes", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.T" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sender = new CloudApiSender({ accessToken: "t", phoneNumberId: "1", graphVersion: "v23.0", fetchImpl });
    await sender.send({ outboxId: 1, messageId: 1, to: "51987654321", text: "x", template: { name: "recordatorio_cita", lang: "es", params: ["Ana", "Cyberplaza"] } });
    await sender.send({ outboxId: 2, messageId: 2, to: "51987654321", text: "x", template: { name: "saludo", lang: "es", params: [] } });
    expect(bodies[0]).toMatchObject({
      type: "template",
      template: { name: "recordatorio_cita", language: { code: "es" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "Cyberplaza" }] }] },
    });
    expect(bodies[0].text).toBeUndefined();
    expect(bodies[1].template.components).toEqual([]);
  });

  it("el outbox no bloquea una plantilla por la ventana de 24 h (sí bloquea el texto libre)", async () => {
    const repo = new Repo(openDb(":memory:"));
    const sender = new CaptureSender();
    const outbox = new Outbox(repo, sender, log);
    const c = repo.upsertCustomer("519", "X");
    const conv = repo.getOrCreateConversation(c.id);
    repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: "hola", createdAt: "2020-01-01T00:00:00.000Z" });
    outbox.enqueue({ conversationId: conv.id, toWaId: "519", body: "libre", author: "bot" });
    outbox.enqueue({ conversationId: conv.id, toWaId: "519", body: "plantilla", author: "bot", template: { name: "t", lang: "es", params: [] } });
    await outbox.flush();
    expect(sender.sent.map((s) => s.text)).toEqual(["plantilla"]);
  });
});

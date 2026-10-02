import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AppointmentService, type CitaEvent } from "../src/appointments/service.js";
import { formatAlertText, AlertDispatcher } from "../src/notify.js";
import { parseSedes } from "../src/knowledge/sedes.js";
import { Auth } from "../src/panel/auth.js";
import { buildPanelApp } from "../src/panel/server.js";
import { say, setup, CaptureNotifier } from "./helpers.js";
import pino from "pino";

const SEDES = parseSedes(fs.readFileSync(new URL("../knowledge/sedes.yml", import.meta.url), "utf8"));
const MON_9AM = new Date("2026-10-05T14:00:00Z");
const PASSWORD = "clave-segura-123";

async function agendaSetup(enabled = true) {
  const ctx = setup([say("ok")]);
  const events: CitaEvent[] = [];
  const appointments = new AppointmentService(ctx.repo, () => (enabled ? SEDES : { ...SEDES, citas: undefined }), { onChange: (e) => events.push(e) }, () => MON_9AM);
  const panel = await buildPanelApp({
    cfg: ctx.cfg,
    repo: ctx.repo,
    outbox: ctx.outbox,
    bus: ctx.bus,
    auth: new Auth({ password: PASSWORD, secret: "s".repeat(32), secure: false }),
    log: ctx.log,
    appointments,
    info: { provider: "ollama", model: "fake", sendConfigured: false, alertChannel: "none" as const, knowledgePending: () => [] },
    webDir: "/no/existe",
  });
  const cookie = String((await panel.inject({ method: "POST", url: "/api/auth/login", payload: { password: PASSWORD } })).headers["set-cookie"]).split(";")[0]!;
  const call = (method: "GET" | "POST", url: string, payload?: unknown) => panel.inject({ method, url, payload: payload as object, headers: { cookie } });
  return { ...ctx, panel, call, events, appointments };
}

const RANGE = "from=2026-10-05&to=2026-10-11";
const manual = { phone: "987654321", sede: "cyberplaza", fecha: "2026-10-06", hora: "10:00", nombre: "Luis Pérez", motivo: "comprar impresora" };

describe("agenda del panel", () => {
  it("exige sesión", async () => {
    const ctx = await agendaSetup();
    expect((await ctx.panel.inject({ method: "GET", url: `/api/agenda?${RANGE}` })).statusCode).toBe(401);
  });

  it("sin citas configuradas responde 404 claro", async () => {
    const ctx = await agendaSetup(false);
    const res = await ctx.call("GET", `/api/agenda?${RANGE}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("sedes.yml");
    expect((await ctx.call("GET", "/api/status")).json().appointmentsEnabled).toBe(false);
  });

  it("crea una cita a mano (teléfono peruano de 9 dígitos), la lista con hora de Lima y la ve el cliente", async () => {
    const ctx = await agendaSetup();
    const created = await ctx.call("POST", "/api/agenda", manual);
    expect(created.statusCode).toBe(200);
    const appt = created.json().appointment;
    expect(appt).toMatchObject({ date: "2026-10-06", time: "10:00", endTime: "11:00", sede: "cyberplaza", status: "confirmada", source: "panel", contactName: "Luis Pérez" });
    expect(appt.customer.waId).toBe("51987654321");

    const list = (await ctx.call("GET", `/api/agenda?${RANGE}`)).json();
    expect(list.sedes.map((s: { id: string }) => s.id)).toEqual(["cyberplaza", "san-isidro"]);
    expect(list.appointments).toHaveLength(1);

    const filtered = (await ctx.call("GET", `/api/agenda?${RANGE}&sede=san-isidro`)).json();
    expect(filtered.appointments).toHaveLength(0);

    const conv = ctx.repo.getOrCreateConversation(appt.customer.id);
    const detail = (await ctx.call("GET", `/api/conversations/${conv.id}`)).json();
    expect(detail.customer.appointments[0].text).toContain("martes 6 de octubre a las 10:00 en Cyberplaza");
    expect(ctx.events.map((e) => `${e.kind}:${e.by}`)).toEqual(["creada:panel"]);
  });

  it("respeta las reglas del negocio también desde el panel (cupos y feriados)", async () => {
    const ctx = await agendaSetup();
    await ctx.call("POST", "/api/agenda", manual);
    await ctx.call("POST", "/api/agenda", { ...manual, phone: "987654322" });
    const full = await ctx.call("POST", "/api/agenda", { ...manual, phone: "987654323" });
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe("sin_cupo");
    const holiday = await ctx.call("POST", "/api/agenda", { ...manual, fecha: "2026-10-08" });
    expect(holiday.json().code).toBe("feriado");
    expect((await ctx.call("POST", "/api/agenda", { ...manual, phone: "12" })).statusCode).toBe(400);
  });

  it("horas libres para el selector", async () => {
    const ctx = await agendaSetup();
    await ctx.call("POST", "/api/agenda", manual);
    await ctx.call("POST", "/api/agenda", { ...manual, phone: "987654322" });
    const hours = (await ctx.call("GET", "/api/agenda/slots?sede=cyberplaza&fecha=2026-10-06")).json().hours as string[];
    expect(hours).not.toContain("10:00");
    expect(hours).toContain("11:00");
    expect((await ctx.call("GET", "/api/agenda/slots?sede=cyberplaza&fecha=2026-10-08")).json().hours).toEqual([]);
  });

  it("mueve, marca asistencia y cancela", async () => {
    const ctx = await agendaSetup();
    const id = (await ctx.call("POST", "/api/agenda", manual)).json().appointment.id as number;
    const moved = await ctx.call("POST", `/api/agenda/${id}/reschedule`, { fecha: "2026-10-07", hora: "15:00" });
    expect(moved.json().appointment).toMatchObject({ date: "2026-10-07", time: "15:00" });
    expect((await ctx.call("POST", `/api/agenda/${id}/status`, { status: "completada" })).json().appointment.status).toBe("completada");
    const id2 = (await ctx.call("POST", "/api/agenda", { ...manual, phone: "987654399" })).json().appointment.id as number;
    expect((await ctx.call("POST", `/api/agenda/${id2}/cancel`)).json().appointment.status).toBe("cancelada");
    expect((await ctx.call("POST", `/api/agenda/${id2}/cancel`)).statusCode).toBe(409);
    expect((await ctx.call("POST", "/api/agenda/9999/cancel")).statusCode).toBe(404);
    expect((await ctx.call("POST", `/api/agenda/${id}/resync`)).json().code).toBe("sin_calendario");
  });

  it("emite eventos de agenda por SSE", async () => {
    const ctx = await agendaSetup();
    const seen: string[] = [];
    ctx.bus.subscribe((e) => seen.push(e.type));
    const id = (await ctx.call("POST", "/api/agenda", manual)).json().appointment.id as number;
    await ctx.call("POST", `/api/agenda/${id}/status`, { status: "no_asistio" });
    expect(seen).toContain("agenda");
  });
});

describe("alertas de citas", () => {
  it("dan el detalle de la cita, sin 'último mensaje' y sin enfriamiento entre citas distintas", async () => {
    const notifier = new CaptureNotifier();
    const alerts = new AlertDispatcher(notifier, pino({ level: "silent" }));
    const a = { type: "cita_nueva" as const, conversationId: 7, customerName: "Ana", waId: "519", reason: "Cita #1 · martes 6 de octubre a las 10:00 en Cyberplaza" };
    alerts.dispatch(a);
    alerts.dispatch({ ...a, reason: "Cita #2 · …" });
    await new Promise((r) => setTimeout(r, 5));
    expect(notifier.alerts).toHaveLength(2);
    const text = formatAlertText(a);
    expect(text).toContain("Nueva cita en tienda");
    expect(text).toContain("Detalle: Cita #1");
    expect(text).not.toContain("Último mensaje");
  });
});

import { createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { GoogleCalendarClient, GoogleSync, loadServiceAccount, MAX_SYNC_ATTEMPTS } from "../src/appointments/google.js";
import { AppointmentService } from "../src/appointments/service.js";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";
import { parseSedes } from "../src/knowledge/sedes.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = { client_email: "bot@proyecto.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

const yml = fs.readFileSync(new URL("../knowledge/sedes.yml", import.meta.url), "utf8");
const SEDES = parseSedes(yml);
SEDES.sedes[0]!.calendar_id = "cal-cyber@group.calendar.google.com"; // San Isidro queda sin calendario
const MON_9AM = new Date("2026-10-05T14:00:00Z");

interface Call { method: string; url: string; body?: any; auth?: string }

/** Google falso: token + Calendar. `failWith` fuerza un estado HTTP en las llamadas a Calendar. */
function fakeGoogle() {
  const calls: Call[] = [];
  const state = { failWith: 0, deleteStatus: 200, nextId: 1, tokens: 0 };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("https://oauth2.test/")) {
      state.tokens++;
      const form = new URLSearchParams(String(init!.body));
      calls.push({ method, url, body: Object.fromEntries(form) });
      return Response.json({ access_token: `tok-${state.tokens}`, expires_in: 3600 });
    }
    const auth = (init?.headers as Record<string, string>)?.authorization;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth });
    if (state.failWith) return Response.json({ error: { message: "boom" } }, { status: state.failWith });
    if (method === "DELETE") return new Response(null, { status: state.deleteStatus });
    return Response.json({ id: `ev${state.nextId++}` });
  }) as typeof fetch;
  return { calls, state, fetchImpl };
}

function make() {
  const g = fakeGoogle();
  const repo = new Repo(openDb(":memory:"));
  const svc = new AppointmentService(repo, () => SEDES, {}, () => MON_9AM);
  const client = new GoogleCalendarClient({ account, fetchImpl: g.fetchImpl, tokenUrl: "https://oauth2.test/token", apiBase: "https://cal.test/v3", now: () => MON_9AM.getTime() });
  const gaveUp: number[] = [];
  const sync = new GoogleSync(repo, client, () => SEDES, pino({ level: "silent" }), (a) => gaveUp.push(a.id));
  const customer = repo.upsertCustomer("51999000001", "Ana");
  const book = (sede = "cyberplaza", hora = "10:00") =>
    svc.book({ customerId: customer.id, sede, fecha: "2026-10-06", hora, nombre: "Ana Torres", motivo: "ver impresoras" });
  return { ...g, repo, svc, sync, book, gaveUp };
}

describe("cuenta de servicio", () => {
  it("firma un JWT RS256 válido con el alcance de eventos y lo canjea por un token", async () => {
    const m = make();
    const r = m.book();
    expect(r.ok && r.value.google_sync).toBe("pendiente");
    await m.sync.run();
    const tokenCall = m.calls.find((c) => c.url.startsWith("https://oauth2.test/"))!;
    expect(tokenCall.body.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = tokenCall.body.assertion.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: account.client_email, scope: "https://www.googleapis.com/auth/calendar.events", aud: "https://oauth2.test/token" });
    expect(claims.exp - claims.iat).toBe(3600);
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  it("reutiliza el token mientras no caduque", async () => {
    const m = make();
    m.book();
    m.book("cyberplaza", "11:00");
    await m.sync.run();
    expect(m.state.tokens).toBe(1);
  });

  it("valida el archivo de la clave", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsa-"));
    const f = path.join(dir, "k.json");
    fs.writeFileSync(f, JSON.stringify({ foo: 1 }));
    expect(() => loadServiceAccount(f)).toThrow(/client_email/);
    expect(() => loadServiceAccount(path.join(dir, "no-existe.json"))).toThrow(/No se pudo leer/);
    fs.writeFileSync(f, JSON.stringify(account));
    expect(loadServiceAccount(f).client_email).toBe(account.client_email);
  });
});

describe("espejo de citas", () => {
  it("crea el evento en el calendario de la sede, con hora de Lima y datos útiles", async () => {
    const m = make();
    const r = m.book();
    if (!r.ok) throw new Error();
    await m.sync.run();
    const call = m.calls.find((c) => c.method === "POST" && c.url.includes("/calendars/"))!;
    expect(call.url).toBe("https://cal.test/v3/calendars/cal-cyber%40group.calendar.google.com/events");
    expect(call.auth).toBe("Bearer tok-1");
    expect(call.body.summary).toBe("Visita: Ana Torres (Cyberplaza)");
    expect(call.body.start).toEqual({ dateTime: "2026-10-06T15:00:00.000Z", timeZone: "America/Lima" });
    expect(call.body.end.dateTime).toBe("2026-10-06T16:00:00.000Z");
    expect(call.body.description).toContain("Motivo: ver impresoras");
    expect(call.body.description).toContain("+51999000001");
    const row = m.repo.getAppointment(r.value.id)!;
    expect([row.google_sync, row.google_event_id]).toEqual(["ok", "ev1"]);
  });

  it("una sede sin calendar_id queda como no_aplica y no llama a Google", async () => {
    const m = make();
    const r = m.book("san-isidro");
    if (!r.ok) throw new Error();
    expect(r.value.google_sync).toBe("no_aplica");
    await m.sync.run();
    expect(m.calls).toHaveLength(0);
  });

  it("reprogramar actualiza el evento y cancelar lo borra (404 al borrar cuenta como éxito)", async () => {
    const m = make();
    const r = m.book();
    if (!r.ok) throw new Error();
    await m.sync.run();
    m.svc.reschedule(r.value.id, { fecha: "2026-10-07", hora: "12:00" });
    expect(m.repo.getAppointment(r.value.id)!.google_sync).toBe("pendiente");
    await m.sync.run();
    const patch = m.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("/events/ev1");
    expect(patch.body.start.dateTime).toBe("2026-10-07T17:00:00.000Z");

    m.state.deleteStatus = 404;
    m.svc.cancel(r.value.id);
    await m.sync.run();
    expect(m.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/events/ev1"))).toBe(true);
    expect(m.repo.getAppointment(r.value.id)!.google_sync).toBe("ok");
    expect(m.repo.appointmentsToSync()).toHaveLength(0);
  });

  it("cancelar una cita que nunca llegó a Google no llama a Google", async () => {
    const m = make();
    const r = m.book();
    if (!r.ok) throw new Error();
    m.svc.cancel(r.value.id);
    expect(m.repo.getAppointment(r.value.id)!.google_sync).toBe("no_aplica");
    await m.sync.run();
    expect(m.calls).toHaveLength(0);
  });

  it("si Google falla, la cita sigue confirmada, se reintenta y al agotar intentos se avisa una vez", async () => {
    const m = make();
    const r = m.book();
    if (!r.ok) throw new Error();
    m.state.failWith = 403;
    for (let i = 0; i < MAX_SYNC_ATTEMPTS + 3; i++) await m.sync.run();
    const row = m.repo.getAppointment(r.value.id)!;
    expect(row.status).toBe("confirmada");
    expect(row.google_sync).toBe("error");
    expect(row.google_error).toContain("403");
    expect(row.google_attempts).toBe(MAX_SYNC_ATTEMPTS);
    expect(m.gaveUp).toEqual([r.value.id]);

    // tras corregir permisos, el panel puede reintentar
    m.state.failWith = 0;
    expect(m.svc.retryGoogle(r.value.id).ok).toBe(true);
    await m.sync.run();
    expect(m.repo.getAppointment(r.value.id)!.google_sync).toBe("ok");
  });

  it("si Google falla un momento y luego vuelve, termina sincronizada sin intervención", async () => {
    const m = make();
    const r = m.book();
    if (!r.ok) throw new Error();
    m.state.failWith = 503;
    await m.sync.run();
    expect(m.repo.getAppointment(r.value.id)!.google_sync).toBe("error");
    m.state.failWith = 0;
    await m.sync.run();
    expect(m.repo.getAppointment(r.value.id)!.google_sync).toBe("ok");
  });
});

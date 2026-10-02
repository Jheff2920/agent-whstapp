import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { AgendaData, Appointment } from "../types";

const DOW = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const parse = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const addDays = (ymd: string, n: number) => ymdOf(new Date(parse(ymd).getTime() + n * 86_400_000));
const label = (ymd: string) => {
  const d = parse(ymd);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
};
/** Hoy en Lima (la agenda siempre se muestra en la hora de la tienda). */
const todayLima = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
const mondayOf = (ymd: string) => addDays(ymd, -((parse(ymd).getUTCDay() + 6) % 7));

const STATUS_LABEL: Record<Appointment["status"], string> = {
  confirmada: "Confirmada",
  cancelada: "Cancelada",
  completada: "Completada",
  no_asistio: "No asistió",
};

export function Agenda({ sedesRefresh, onExpired, onOpenChat }: { sedesRefresh: number; onExpired: () => void; onOpenChat: (conversationId: number) => void }) {
  const [monday, setMonday] = useState(() => mondayOf(todayLima()));
  const [sede, setSede] = useState("");
  const [data, setData] = useState<AgendaData | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<number | null>(null);

  const guard = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onExpired();
      setError(err instanceof Error ? err.message : "Error inesperado");
    },
    [onExpired],
  );

  const load = useCallback(() => api.agenda(monday, addDays(monday, 6), sede).then(setData).catch(guard), [monday, sede, guard]);
  useEffect(() => {
    void load();
  }, [load, sedesRefresh]);

  const sedeName = useMemo(() => new Map((data?.sedes ?? []).map((s) => [s.id, s.nombre])), [data]);
  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (let i = 0; i < 7; i++) map.set(addDays(monday, i), []);
    for (const a of data?.appointments ?? []) map.get(a.date)?.push(a);
    return map;
  }, [data, monday]);

  async function run(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      guard(err);
    }
  }

  const active = (data?.appointments ?? []).filter((a) => a.status === "confirmada").length;
  const failedSync = (data?.appointments ?? []).filter((a) => a.google.sync === "error" && a.status === "confirmada").length;

  return (
    <section className="agenda" aria-label="Agenda de citas">
      <div className="agenda-bar">
        <h2>
          Semana del {label(monday)} <span className="muted small">· {active} cita(s)</span>
        </h2>
        <button onClick={() => setMonday(addDays(monday, -7))} aria-label="Semana anterior">
          ←
        </button>
        <button onClick={() => setMonday(mondayOf(todayLima()))}>Hoy</button>
        <button onClick={() => setMonday(addDays(monday, 7))} aria-label="Semana siguiente">
          →
        </button>
        <select aria-label="Sede" value={sede} onChange={(e) => setSede(e.target.value)}>
          <option value="">Todas las sedes</option>
          {(data?.sedes ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.nombre}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cerrar" : "Nueva cita"}
        </button>
      </div>

      {error && <p className="banner error" role="alert">{error}</p>}
      {failedSync > 0 && (
        <p className="banner warn">
          {failedSync} cita(s) no se copiaron a Google Calendar. Revisa que el calendario esté compartido con la cuenta de servicio y usa «Reintentar».
        </p>
      )}

      {creating && data && (
        <NewForm
          sedes={data.sedes}
          defaultSede={sede || data.sedes[0]?.id || ""}
          onCancel={() => setCreating(false)}
          onCreate={async (a) => {
            setError("");
            try {
              await api.createAppointment(a);
              setCreating(false);
              await load();
            } catch (err) {
              guard(err);
            }
          }}
        />
      )}

      {[...byDay.entries()].map(([day, list]) => (
        <div className="agenda-day" key={day}>
          <h3>
            {label(day)}
            {day === todayLima() ? " · hoy" : ""}
          </h3>
          {list.length === 0 && <p className="muted small">Sin citas.</p>}
          {list.map((a) => (
            <article key={a.id} className={a.status === "confirmada" ? "appt" : "appt off"}>
              <div className="appt-main">
                <span className="appt-time">
                  {a.time}–{a.endTime}
                </span>
                <strong>{a.contactName}</strong>
                <span className="muted">{sedeName.get(a.sede) ?? a.sede}</span>
                <span className="chip">{STATUS_LABEL[a.status]}</span>
                <span className="chip">{a.source === "bot" ? "Asistente" : "Panel"}</span>
                {a.google.sync === "ok" && <span className="chip ok">Google ✓</span>}
                {a.google.sync === "pendiente" && <span className="chip">Google…</span>}
                {a.google.sync === "error" && (
                  <span className="chip danger" title={a.google.error ?? ""}>
                    Google ✗
                  </span>
                )}
              </div>
              <div className="muted small">
                +{a.customer.waId}
                {a.purpose ? ` · ${a.purpose}` : ""}
              </div>
              <div className="appt-actions">
                {a.conversationId && <button onClick={() => onOpenChat(a.conversationId!)}>Abrir chat</button>}
                {a.status === "confirmada" && (
                  <>
                    <button onClick={() => setMoving(moving === a.id ? null : a.id)}>Reprogramar</button>
                    <button onClick={() => void run(() => api.appointmentStatus(a.id, "completada"))}>Completada</button>
                    <button onClick={() => void run(() => api.appointmentStatus(a.id, "no_asistio"))}>No asistió</button>
                    <button
                      onClick={() => window.confirm(`¿Cancelar la cita de ${a.contactName}?`) && void run(() => api.cancelAppointment(a.id))}
                    >
                      Cancelar
                    </button>
                  </>
                )}
                {a.google.sync === "error" && <button onClick={() => void run(() => api.resyncAppointment(a.id))}>Reintentar Google</button>}
              </div>
              {moving === a.id && (
                <MoveForm
                  appt={a}
                  onDone={() => setMoving(null)}
                  onMove={async (fecha, hora) => {
                    setError("");
                    try {
                      await api.rescheduleAppointment(a.id, fecha, hora);
                      setMoving(null);
                      await load();
                    } catch (err) {
                      guard(err);
                    }
                  }}
                />
              )}
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}

function useHours(sede: string, fecha: string, exclude?: number) {
  const [hours, setHours] = useState<string[]>([]);
  useEffect(() => {
    if (!sede || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return setHours([]);
    let alive = true;
    api
      .slots(sede, fecha, exclude)
      .then((r) => alive && setHours(r.hours))
      .catch(() => alive && setHours([]));
    return () => {
      alive = false;
    };
  }, [sede, fecha, exclude]);
  return hours;
}

function NewForm({
  sedes,
  defaultSede,
  onCreate,
  onCancel,
}: {
  sedes: AgendaData["sedes"];
  defaultSede: string;
  onCreate: (a: { phone: string; sede: string; fecha: string; hora: string; nombre: string; motivo?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [nombre, setNombre] = useState("");
  const [motivo, setMotivo] = useState("");
  const [sede, setSede] = useState(defaultSede);
  const [fecha, setFecha] = useState(todayLima());
  const [hora, setHora] = useState("");
  const hours = useHours(sede, fecha);
  useEffect(() => setHora(""), [sede, fecha]);
  const ok = phone.trim().length >= 6 && nombre.trim().length >= 2 && hora !== "";

  return (
    <form
      className="appt-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) void onCreate({ phone, sede, fecha, hora, nombre, motivo: motivo || undefined });
      }}
    >
      <div>
        <label htmlFor="n-phone">WhatsApp del cliente</label>
        <input id="n-phone" inputMode="tel" placeholder="987654321 o 51987654321" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div>
        <label htmlFor="n-name">Nombre de quien viene</label>
        <input id="n-name" value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </div>
      <div>
        <label htmlFor="n-sede">Sede</label>
        <select id="n-sede" value={sede} onChange={(e) => setSede(e.target.value)}>
          {sedes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.nombre}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="n-date">Fecha</label>
        <input id="n-date" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </div>
      <div>
        <label htmlFor="n-hour">Hora</label>
        <select id="n-hour" value={hora} onChange={(e) => setHora(e.target.value)}>
          <option value="">{hours.length ? "Elige una hora" : "Sin horarios libres"}</option>
          {hours.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="n-why">Motivo (opcional)</label>
        <input id="n-why" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </div>
      <div className="span-all">
        <button type="button" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="primary" disabled={!ok}>
          Agendar
        </button>
      </div>
    </form>
  );
}

function MoveForm({ appt, onMove, onDone }: { appt: Appointment; onMove: (fecha: string, hora: string) => Promise<void>; onDone: () => void }) {
  const [fecha, setFecha] = useState(appt.date);
  const [hora, setHora] = useState("");
  const hours = useHours(appt.sede, fecha, appt.id);
  useEffect(() => setHora(""), [fecha]);
  return (
    <form
      className="appt-actions"
      onSubmit={(e) => {
        e.preventDefault();
        if (hora) void onMove(fecha, hora);
      }}
    >
      <input type="date" aria-label="Nueva fecha" value={fecha} onChange={(e) => setFecha(e.target.value)} style={{ width: "auto" }} />
      <select aria-label="Nueva hora" value={hora} onChange={(e) => setHora(e.target.value)} style={{ width: "auto" }}>
        <option value="">{hours.length ? "Hora" : "Sin horarios"}</option>
        {hours.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <button type="submit" className="primary" disabled={!hora}>
        Mover
      </button>
      <button type="button" onClick={onDone}>
        Cerrar
      </button>
    </form>
  );
}

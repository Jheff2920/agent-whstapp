import { parse } from "yaml";
import { z } from "zod";

/** Índice = Date#getDay() (0 = domingo). */
const DAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"] as const;
type Day = (typeof DAYS)[number];
const WEEK_ORDER: Day[] = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
const DAY_LABEL: Record<Day, string> = {
  lunes: "lunes",
  martes: "martes",
  miercoles: "miércoles",
  jueves: "jueves",
  viernes: "viernes",
  sabado: "sábado",
  domingo: "domingo",
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

const windowSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, "formato esperado HH:MM-HH:MM")
  .refine((w) => toMinutes(w.slice(0, 5)) < toMinutes(w.slice(6)), "la hora de cierre debe ser posterior a la de apertura");

const horarioSchema = z.object(
  Object.fromEntries(DAYS.map((d) => [d, z.array(windowSchema).default([])])) as Record<Day, z.ZodDefault<z.ZodArray<typeof windowSchema>>>,
);

const sedeSchema = z.object({
  id: z.string().min(1),
  nombre: z.string().min(1),
  direccion: z.string().min(1),
  horario: horarioSchema,
});

const fileSchema = z.object({
  zona_horaria: z.string().default("America/Lima"),
  sedes: z.array(sedeSchema).min(1),
});

export type Sede = z.infer<typeof sedeSchema>;
export type Sedes = z.infer<typeof fileSchema>;

export function parseSedes(text: string): Sedes {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new Error(`knowledge/sedes.yml inválido: ${(err as Error).message}`);
  }
  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`knowledge/sedes.yml inválido: ${detail}`);
  }
  return result.data;
}

/** "lunes a viernes 09:00-18:00; sábado 09:00-13:00; domingo cerrado" */
export function describeSchedule(horario: Sede["horario"]): string {
  const key = (d: Day) => horario[d].join(" y ") || "cerrado";
  const groups: { days: Day[]; key: string }[] = [];
  for (const d of WEEK_ORDER) {
    const last = groups[groups.length - 1];
    if (last && last.key === key(d)) last.days.push(d);
    else groups.push({ days: [d], key: key(d) });
  }
  return groups
    .map((g) => {
      const first = DAY_LABEL[g.days[0]!];
      const label = g.days.length === 1 ? first : `${first} a ${DAY_LABEL[g.days[g.days.length - 1]!]}`;
      return `${label} ${g.key}`;
    })
    .join("; ");
}

/** Sección del prompt con dirección y horario de cada sede. */
export function renderSedes(s: Sedes): string {
  return s.sedes
    .map((x) => `## Sede ${x.nombre}\nDirección: ${x.direccion}\nHorario (hora de ${s.zona_horaria}): ${describeSchedule(x.horario)}.`)
    .join("\n\n");
}

function localClock(now: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/** Estado calculado (no inferido por el modelo): qué sedes están abiertas ahora y cuándo abren. */
export function openStatus(s: Sedes, now: Date): string {
  const { day, minutes } = localClock(now, s.zona_horaria);
  return s.sedes
    .map((sede) => {
      const today = sede.horario[DAYS[day]!];
      for (const w of today) {
        const start = toMinutes(w.slice(0, 5));
        const end = toMinutes(w.slice(6));
        if (minutes >= start && minutes < end) return `- ${sede.nombre}: abierta ahora (cierra a las ${w.slice(6)})`;
      }
      const later = today.find((w) => toMinutes(w.slice(0, 5)) > minutes);
      if (later) return `- ${sede.nombre}: cerrada ahora; abre hoy a las ${later.slice(0, 5)}`;
      for (let i = 1; i <= 7; i++) {
        const d = DAYS[(day + i) % 7]!;
        const w = sede.horario[d][0];
        if (w) {
          const when = i === 1 ? "mañana" : `el ${DAY_LABEL[d]}`;
          return `- ${sede.nombre}: cerrada ahora; abre ${when} a las ${w.slice(0, 5)}`;
        }
      }
      return `- ${sede.nombre}: sin horario cargado`;
    })
    .join("\n");
}

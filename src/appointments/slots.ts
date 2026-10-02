import type { Sede, Sedes } from "../knowledge/sedes.js";
import { addDays, dowOfYmd, zonedToUtc } from "./time.js";

const DAY_KEYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"] as const;

export interface Slot {
  start: Date;
  end: Date;
}

export const isHoliday = (s: Sedes, ymd: string): boolean => s.feriados.includes(ymd);

/** Ventanas de atención de la sede ese día ("10:00-19:00"), vacías si cierra. */
export const dayWindows = (sede: Sede, ymd: string): string[] => sede.horario[DAY_KEYS[dowOfYmd(ymd)]!];

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Franjas teóricas de un día: arrancan al abrir cada ventana y avanzan de `duracion_min` en `duracion_min`,
 * sin pasarse de la hora de cierre. Los feriados no tienen franjas.
 */
export function slotsForDay(s: Sedes, sede: Sede, ymd: string): Slot[] {
  if (!s.citas || isHoliday(s, ymd)) return [];
  const dur = s.citas.duracion_min;
  const out: Slot[] = [];
  for (const w of dayWindows(sede, ymd)) {
    for (let t = toMin(w.slice(0, 5)); t + dur <= toMin(w.slice(6)); t += dur) {
      out.push({ start: zonedToUtc(ymd, toHm(t), s.zona_horaria), end: zonedToUtc(ymd, toHm(t + dur), s.zona_horaria) });
    }
  }
  return out;
}

/** Aviso si la lista de feriados no cubre todo el período en el que se puede reservar (None = todo bien). */
export function holidayCoverageWarning(s: Sedes, todayYmd: string): string | undefined {
  if (!s.citas) return undefined;
  const last = [...s.feriados].sort().pop();
  const horizon = addDays(todayYmd, s.citas.horizonte_dias);
  if (!last) return "knowledge/sedes.yml no tiene feriados cargados: el agente podría agendar citas en días no laborables";
  return last < horizon ? `La lista de feriados termina el ${last}, antes del fin del período reservable (${horizon}): actualiza knowledge/sedes.yml` : undefined;
}

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Diferencia (ms) entre la hora local de `tz` y UTC en ese instante. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

export const isValidYmd = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const isValidHm = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Convierte fecha y hora locales de `tz` ("2026-10-08", "10:00") a un instante UTC. */
export function zonedToUtc(ymd: string, hm: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const [h, mi] = hm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

export const localYmd = (date: Date, tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);

export function localHm(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g("hour")}:${g("minute")}`;
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = domingo … 6 = sábado, para una fecha AAAA-MM-DD. */
export function dowOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "jueves 8 de octubre" */
export function dayLabel(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return `${DIAS[dowOfYmd(ymd)]} ${d} de ${MESES[m - 1]}`;
}

/** "jueves 8 de octubre a las 10:00" (hora local de `tz`). */
export function whenLabel(date: Date, tz: string): string {
  return `${dayLabel(localYmd(date, tz))} a las ${localHm(date, tz)}`;
}

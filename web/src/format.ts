const TZ = "America/Lima";

const timeFmt = new Intl.DateTimeFormat("es-PE", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("es-PE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const shortFmt = new Intl.DateTimeFormat("es-PE", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

export const hhmm = (iso: string) => timeFmt.format(new Date(iso));
export const dayLabel = (iso: string) => dayFmt.format(new Date(iso));
export const dayKey = (iso: string) => ymd.format(new Date(iso));

/** Hora si es de hoy, "ayer" o dd/mm. */
export function listTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = ymd.format(new Date());
  if (ymd.format(d) === today) return timeFmt.format(d);
  const yesterday = ymd.format(new Date(Date.now() - 24 * 3600_000));
  if (ymd.format(d) === yesterday) return "ayer";
  return shortFmt.format(d);
}

export const displayName = (name: string | null, waId: string) => name?.trim() || `+${waId}`;

export function initials(name: string | null, waId: string): string {
  const base = name?.trim();
  if (!base) return waId.slice(-2);
  return base
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** "quedan 5 h" o "vencida" para la ventana de 24 h de WhatsApp. */
export function windowText(closesAt: string | null, open: boolean): string {
  if (!open || !closesAt) return "Ventana de 24 h vencida";
  const mins = Math.max(0, Math.round((new Date(closesAt).getTime() - Date.now()) / 60_000));
  return mins >= 60 ? `Ventana abierta: ${Math.floor(mins / 60)} h` : `Ventana abierta: ${mins} min`;
}

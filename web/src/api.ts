import type { AgendaData, Appointment, Detail, ListItem, NewAppointment, Status } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Error ${res.status}`, res.status, data.code);
  return data as T;
}

export const api = {
  me: () => call<{ authenticated: boolean; configured: boolean }>("GET", "/api/auth/me"),
  login: (password: string) => call<{ ok: true }>("POST", "/api/auth/login", { password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  conversations: (filter: string, q: string) =>
    call<{ conversations: ListItem[] }>("GET", `/api/conversations?filter=${filter}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  conversation: (id: number) => call<Detail>("GET", `/api/conversations/${id}`),
  takeover: (id: number) => call<Detail>("POST", `/api/conversations/${id}/takeover`),
  release: (id: number) => call<Detail>("POST", `/api/conversations/${id}/release`),
  send: (id: number, text: string) => call<Detail>("POST", `/api/conversations/${id}/send`, { text }),
  note: (id: number, text: string) => call<Detail>("POST", `/api/conversations/${id}/notes`, { text }),
  patchCustomer: (id: number, patch: { name?: string | null; stage?: string; summary?: string | null }) =>
    call<Detail>("PATCH", `/api/customers/${id}`, patch),
  putFact: (id: number, key: string, value: string) => call<Detail>("PUT", `/api/customers/${id}/facts`, { key, value }),
  deleteFact: (id: number, key: string) => call<Detail>("DELETE", `/api/customers/${id}/facts/${encodeURIComponent(key)}`),
  status: () => call<Status>("GET", "/api/status"),
  agenda: (from: string, to: string, sede: string) =>
    call<AgendaData>("GET", `/api/agenda?from=${from}&to=${to}${sede ? `&sede=${encodeURIComponent(sede)}` : ""}`),
  slots: (sede: string, fecha: string, exclude?: number) =>
    call<{ hours: string[] }>("GET", `/api/agenda/slots?sede=${encodeURIComponent(sede)}&fecha=${fecha}${exclude ? `&excluir=${exclude}` : ""}`),
  createAppointment: (a: NewAppointment) => call<{ appointment: Appointment }>("POST", "/api/agenda", a),
  cancelAppointment: (id: number) => call<{ appointment: Appointment }>("POST", `/api/agenda/${id}/cancel`),
  rescheduleAppointment: (id: number, fecha: string, hora: string) =>
    call<{ appointment: Appointment }>("POST", `/api/agenda/${id}/reschedule`, { fecha, hora }),
  appointmentStatus: (id: number, status: "completada" | "no_asistio") =>
    call<{ appointment: Appointment }>("POST", `/api/agenda/${id}/status`, { status }),
  resyncAppointment: (id: number) => call<{ appointment: Appointment }>("POST", `/api/agenda/${id}/resync`),
};

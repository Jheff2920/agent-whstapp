export type Mode = "bot" | "humano" | "escalado";
export type Author = "cliente" | "bot" | "humano" | "nota";

export interface WindowInfo {
  open: boolean;
  closesAt: string | null;
}

export interface ListItem {
  id: number;
  mode: Mode;
  unread: number;
  customer: { id: number; name: string | null; waId: string; stage: string; optedOut: boolean };
  lastBody: string | null;
  lastAuthor: Author | null;
  lastMessageAt: string | null;
  window: WindowInfo;
}

export interface Message {
  id: number;
  direction: "in" | "out";
  author: Author;
  body: string;
  status: string;
  createdAt: string;
}

export interface Detail {
  conversation: { id: number; mode: Mode; unread: number; window: WindowInfo };
  customer: {
    id: number;
    name: string | null;
    waId: string;
    stage: string;
    summary: string | null;
    optedOut: boolean;
    createdAt: string;
    facts: { key: string; value: string }[];
    appointments: { id: number; text: string; contactName: string }[];
  };
  messages: Message[];
}

export interface Status {
  llm: { provider: string; model: string };
  sendConfigured: boolean;
  alertsConfigured: boolean;
  alertChannel: "telegram" | "n8n" | "none";
  knowledgePending: string[];
  outbox: { pending: number; failed: number };
  conversations: { escalado: number; humano: number; unread: number };
  timezone: string;
  appointmentsEnabled: boolean;
}

export type ApptStatus = "confirmada" | "cancelada" | "completada" | "no_asistio";

export interface Appointment {
  id: number;
  sede: string;
  date: string;
  time: string;
  endTime: string;
  startsAt: string;
  contactName: string;
  purpose: string | null;
  status: ApptStatus;
  source: "bot" | "panel";
  google: { sync: "pendiente" | "ok" | "error" | "no_aplica"; error: string | null };
  customer: { id: number; name: string | null; waId: string };
  conversationId: number | null;
}

export interface AgendaData {
  from: string;
  to: string;
  sedes: { id: string; nombre: string; googleCalendar: boolean }[];
  appointments: Appointment[];
}

export interface NewAppointment {
  phone: string;
  sede: string;
  fecha: string;
  hora: string;
  nombre: string;
  motivo?: string;
}

export const STAGES = [
  ["nuevo", "Nuevo"],
  ["interesado", "Interesado"],
  ["cotizando", "Cotizando"],
  ["cita_agendada", "Cita agendada"],
  ["cerrado_ganado", "Cerrado (ganado)"],
  ["cerrado_perdido", "Cerrado (perdido)"],
] as const;

export const MODE_LABEL: Record<Mode, string> = { bot: "Asistente", humano: "Asesor", escalado: "Escalado" };

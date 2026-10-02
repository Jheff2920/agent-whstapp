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
  };
  messages: Message[];
}

export interface Status {
  llm: { provider: string; model: string };
  n8nSendConfigured: boolean;
  alertsConfigured: boolean;
  knowledgePending: string[];
  outbox: { pending: number; failed: number };
  conversations: { escalado: number; humano: number; unread: number };
  timezone: string;
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

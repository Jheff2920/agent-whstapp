export interface InboundMessage {
  waMessageId: string;
  from: string;
  name?: string;
  body: string;
}

export interface StatusUpdate {
  waMessageId: string;
  status: string;
}

type Json = Record<string, any>;

/** Extrae mensajes y estados de entrega del webhook de la Cloud API de WhatsApp. */
export function parseWebhook(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const entries: Json[] = Array.isArray((payload as Json)?.entry) ? (payload as Json).entry : [];

  for (const entry of entries) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value: Json = change?.value ?? {};
      const names = new Map<string, string>();
      for (const c of Array.isArray(value.contacts) ? value.contacts : []) {
        if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
      }
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        if (!m?.id || !m?.from) continue;
        const body = extractBody(m);
        if (body === null) continue;
        messages.push({
          waMessageId: String(m.id),
          from: String(m.from),
          name: names.get(String(m.from)),
          body,
        });
      }
      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        if (s?.id && s?.status) statuses.push({ waMessageId: String(s.id), status: String(s.status) });
      }
    }
  }
  return { messages, statuses };
}

/** Devuelve null para eventos que no deben generar respuesta (p. ej. reacciones). */
function extractBody(m: Json): string | null {
  switch (m.type) {
    case "text":
      return typeof m.text?.body === "string" ? m.text.body : "";
    case "button":
      return m.button?.text ?? "";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interactivo]";
    case "reaction":
      return null;
    default:
      return `[${m.type ?? "desconocido"}]`;
  }
}

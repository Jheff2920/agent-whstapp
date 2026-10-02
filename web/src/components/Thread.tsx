import { useEffect, useRef, useState } from "react";
import { dayKey, dayLabel, displayName, hhmm, initials, windowText } from "../format";
import { MODE_LABEL, type Detail, type Message } from "../types";

const STATUS_LABEL: Record<string, string> = {
  queued: "En cola",
  sent: "Enviado",
  delivered: "Entregado",
  read: "Leído",
  failed: "No se envió",
};

function Bubble({ m }: { m: Message }) {
  if (m.author === "nota") {
    return (
      <div className="note" role="note">
        <span>{m.body}</span>
        <time>{hhmm(m.createdAt)}</time>
      </div>
    );
  }
  const mine = m.direction === "out";
  return (
    <div className={`bubble-row ${mine ? "out" : "in"}`}>
      <div className={`bubble ${m.author}`}>
        {mine && <span className="who">{m.author === "bot" ? "Asistente" : "Asesor"}</span>}
        <p>{m.body}</p>
        <span className="meta">
          <time>{hhmm(m.createdAt)}</time>
          {mine && (
            <span className={m.status === "failed" ? "status failed" : "status"}>{STATUS_LABEL[m.status] ?? m.status}</span>
          )}
        </span>
      </div>
    </div>
  );
}

export interface ThreadProps {
  detail: Detail;
  busy: boolean;
  error: string;
  onBack: () => void;
  onInfo: () => void;
  onTakeover: () => void;
  onRelease: () => void;
  onSend: (text: string) => Promise<boolean>;
  onNote: (text: string) => Promise<boolean>;
}

export function Thread(p: ThreadProps) {
  const { detail } = p;
  const [text, setText] = useState("");
  const [asNote, setAsNote] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastId = detail.messages.at(-1)?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, detail.conversation.id]);

  useEffect(() => {
    setText("");
    setAsNote(false);
  }, [detail.conversation.id]);

  const mode = detail.conversation.mode;
  const win = detail.conversation.window;
  const blocked = !asNote && (!win.open || detail.customer.optedOut);

  async function submit() {
    const value = text.trim();
    if (!value || blocked || p.busy) return;
    const ok = asNote ? await p.onNote(value) : await p.onSend(value);
    if (ok) setText("");
  }

  let lastDay = "";
  return (
    <section className="thread" aria-label="Conversación">
      <header className="thread-head">
        <button className="ghost back" onClick={p.onBack} aria-label="Volver a la lista">
          ←
        </button>
        <span className={`avatar ${mode}`} aria-hidden>
          {initials(detail.customer.name, detail.customer.waId)}
        </span>
        <div className="thread-title">
          <strong>{displayName(detail.customer.name, detail.customer.waId)}</strong>
          <span className="muted">
            +{detail.customer.waId} · {windowText(win.closesAt, win.open)}
          </span>
        </div>
        <span className={`badge ${mode}`}>{MODE_LABEL[mode]}</span>
        {mode !== "humano" && (
          <button className="primary" onClick={p.onTakeover} disabled={p.busy}>
            Tomar control
          </button>
        )}
        {mode !== "bot" && (
          <button onClick={p.onRelease} disabled={p.busy}>
            Devolver al asistente
          </button>
        )}
        <button className="ghost info-btn" onClick={p.onInfo} aria-label="Ver ficha del cliente">
          Ficha
        </button>
      </header>

      <div className="messages">
        {detail.messages.map((m) => {
          const key = dayKey(m.createdAt);
          const sep = key !== lastDay;
          lastDay = key;
          return (
            <div key={m.id}>
              {sep && <div className="day">{dayLabel(m.createdAt)}</div>}
              <Bubble m={m} />
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <footer className="composer">
        {p.error && (
          <p className="banner error" role="alert">
            {p.error}
          </p>
        )}
        {detail.customer.optedOut && !asNote && (
          <p className="banner warn">El cliente pidió no recibir más mensajes. Solo puedes dejar notas internas.</p>
        )}
        {!win.open && !detail.customer.optedOut && !asNote && (
          <p className="banner warn">
            Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite enviar plantillas aprobadas.
          </p>
        )}
        {mode === "bot" && !asNote && win.open && (
          <p className="hint">Al enviar tomarás el control: el asistente dejará de responder en esta conversación.</p>
        )}
        <div className="composer-tabs" role="tablist">
          <button role="tab" aria-selected={!asNote} className={!asNote ? "tab active" : "tab"} onClick={() => setAsNote(false)}>
            Responder al cliente
          </button>
          <button role="tab" aria-selected={asNote} className={asNote ? "tab active" : "tab"} onClick={() => setAsNote(true)}>
            Nota interna
          </button>
        </div>
        <div className="composer-row">
          <textarea
            aria-label={asNote ? "Nota interna" : "Mensaje para el cliente"}
            placeholder={asNote ? "Solo la ven los asesores" : "Escribe un mensaje (Enter envía, Shift+Enter salto de línea)"}
            rows={2}
            value={text}
            disabled={blocked}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="primary" onClick={() => void submit()} disabled={blocked || p.busy || !text.trim()}>
            {asNote ? "Guardar nota" : "Enviar"}
          </button>
        </div>
      </footer>
    </section>
  );
}

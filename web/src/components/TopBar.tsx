import type { Status } from "../types";

export type View = "chats" | "agenda";

export function TopBar({
  status,
  view,
  onView,
  onLogout,
}: {
  status: Status | null;
  view: View;
  onView: (v: View) => void;
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          RS
        </span>
        <strong>Red Soluciones</strong>
      </div>
      {status?.appointmentsEnabled && (
        <nav className="tabs" aria-label="Secciones">
          <button className={view === "chats" ? "tab on" : "tab"} aria-current={view === "chats"} onClick={() => onView("chats")}>
            Conversaciones
          </button>
          <button className={view === "agenda" ? "tab on" : "tab"} aria-current={view === "agenda"} onClick={() => onView("agenda")}>
            Agenda
          </button>
        </nav>
      )}
      <div className="chips">
        {status && (
          <>
            <span className="chip" title="Modelo de lenguaje en uso">
              {status.llm.provider} · {status.llm.model}
            </span>
            {status.conversations.escalado > 0 && (
              <span className="chip danger">{status.conversations.escalado} escalada(s)</span>
            )}
            {status.outbox.failed > 0 && <span className="chip danger">{status.outbox.failed} sin enviar</span>}
            {status.outbox.pending > 0 && <span className="chip">{status.outbox.pending} en cola</span>}
            {!status.sendConfigured && <span className="chip warn">Envío a WhatsApp sin configurar</span>}
            {!status.alertsConfigured && <span className="chip warn hide-sm">Alertas sin configurar</span>}
            {status.knowledgePending.length > 0 && (
              <span className="chip warn hide-sm" title={status.knowledgePending.join(", ")}>
                Conocimiento incompleto
              </span>
            )}
          </>
        )}
      </div>
      <button className="ghost" onClick={onLogout}>
        Salir
      </button>
    </header>
  );
}

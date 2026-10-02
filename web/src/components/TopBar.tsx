import type { Status } from "../types";

export function TopBar({ status, onLogout }: { status: Status | null; onLogout: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          RS
        </span>
        <strong>Red Soluciones</strong>
        <span className="muted hide-sm">Conversaciones</span>
      </div>
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
            {!status.n8nSendConfigured && <span className="chip warn">Envío a WhatsApp sin configurar</span>}
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

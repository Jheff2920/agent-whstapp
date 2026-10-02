import { displayName, initials, listTime } from "../format";
import { MODE_LABEL, type ListItem } from "../types";

const FILTERS = [
  ["todas", "Todas"],
  ["escalado", "Escaladas"],
  ["humano", "Con asesor"],
  ["bot", "Asistente"],
  ["sin_leer", "Sin leer"],
] as const;

export interface ListProps {
  items: ListItem[];
  activeId: number | null;
  filter: string;
  query: string;
  loading: boolean;
  onFilter: (f: string) => void;
  onQuery: (q: string) => void;
  onSelect: (id: number) => void;
}

export function ConversationList(p: ListProps) {
  return (
    <aside className="list" aria-label="Conversaciones">
      <div className="list-head">
        <input
          type="search"
          placeholder="Buscar por nombre, número o mensaje"
          aria-label="Buscar conversaciones"
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
        />
        <div className="filters" role="tablist">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={p.filter === key}
              className={p.filter === key ? "tab active" : "tab"}
              onClick={() => p.onFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="items">
        {p.items.map((c) => (
          <li key={c.id}>
            <button className={c.id === p.activeId ? "item active" : "item"} onClick={() => p.onSelect(c.id)}>
              <span className={`avatar ${c.mode}`} aria-hidden>
                {initials(c.customer.name, c.customer.waId)}
              </span>
              <span className="item-body">
                <span className="item-top">
                  <strong className="ellipsis">{displayName(c.customer.name, c.customer.waId)}</strong>
                  <time className="muted">{listTime(c.lastMessageAt)}</time>
                </span>
                <span className="item-bottom">
                  <span className="ellipsis muted">
                    {c.lastAuthor && c.lastAuthor !== "cliente" ? `${c.lastAuthor === "bot" ? "Asistente" : "Tú"}: ` : ""}
                    {c.lastBody ?? "Sin mensajes"}
                  </span>
                  {c.unread > 0 && (
                    <span className="unread" aria-label={`${c.unread} sin leer`}>
                      {c.unread}
                    </span>
                  )}
                </span>
                <span className="item-tags">
                  <span className={`badge ${c.mode}`}>{MODE_LABEL[c.mode]}</span>
                  {c.customer.optedOut && <span className="badge off">Dado de baja</span>}
                  {!c.window.open && <span className="badge off">24 h vencida</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
        {p.items.length === 0 && (
          <li className="empty">{p.loading ? "Cargando…" : "No hay conversaciones con ese filtro."}</li>
        )}
      </ul>
    </aside>
  );
}

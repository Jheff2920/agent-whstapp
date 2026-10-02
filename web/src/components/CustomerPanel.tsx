import { useEffect, useState } from "react";
import { displayName } from "../format";
import { STAGES, type Detail } from "../types";

export interface CustomerPanelProps {
  detail: Detail;
  open: boolean;
  onClose: () => void;
  onPatch: (patch: { name?: string | null; stage?: string; summary?: string | null }) => Promise<void>;
  onPutFact: (key: string, value: string) => Promise<void>;
  onDeleteFact: (key: string) => Promise<void>;
}

export function CustomerPanel({ detail, open, onClose, onPatch, onPutFact, onDeleteFact }: CustomerPanelProps) {
  const c = detail.customer;
  const [name, setName] = useState(c.name ?? "");
  const [summary, setSummary] = useState(c.summary ?? "");
  const [factKey, setFactKey] = useState("");
  const [factValue, setFactValue] = useState("");

  useEffect(() => {
    setName(c.name ?? "");
    setSummary(c.summary ?? "");
  }, [c.id, c.name, c.summary]);

  return (
    <aside className={open ? "info open" : "info"} aria-label="Ficha del cliente">
      <header className="info-head">
        <strong>Ficha del cliente</strong>
        <button className="ghost close" onClick={onClose} aria-label="Cerrar ficha">
          ✕
        </button>
      </header>

      <label htmlFor="c-name">Nombre</label>
      <input
        id="c-name"
        value={name}
        placeholder={displayName(null, c.waId)}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() !== (c.name ?? "") && void onPatch({ name: name.trim() || null })}
      />
      <p className="muted small">WhatsApp: +{c.waId}</p>

      <label htmlFor="c-stage">Etapa comercial</label>
      <select id="c-stage" value={c.stage} onChange={(e) => void onPatch({ stage: e.target.value })}>
        {STAGES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <label htmlFor="c-summary">Resumen</label>
      <textarea
        id="c-summary"
        rows={4}
        value={summary}
        placeholder="Notas generales sobre el cliente"
        onChange={(e) => setSummary(e.target.value)}
        onBlur={() => summary.trim() !== (c.summary ?? "") && void onPatch({ summary: summary.trim() || null })}
      />

      <h3>Datos recordados</h3>
      <ul className="facts">
        {c.facts.map((f) => (
          <li key={f.key}>
            <span>
              <strong>{f.key.replace(/_/g, " ")}</strong>
              <br />
              {f.value}
            </span>
            <button className="ghost" aria-label={`Borrar ${f.key}`} onClick={() => void onDeleteFact(f.key)}>
              ✕
            </button>
          </li>
        ))}
        {c.facts.length === 0 && <li className="muted">Aún no hay datos guardados.</li>}
      </ul>
      <form
        className="fact-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!factKey.trim() || !factValue.trim()) return;
          void onPutFact(factKey, factValue).then(() => {
            setFactKey("");
            setFactValue("");
          });
        }}
      >
        <input aria-label="Dato" placeholder="Dato (p. ej. negocio)" value={factKey} onChange={(e) => setFactKey(e.target.value)} />
        <input aria-label="Valor" placeholder="Valor" value={factValue} onChange={(e) => setFactValue(e.target.value)} />
        <button type="submit" disabled={!factKey.trim() || !factValue.trim()}>
          Agregar
        </button>
      </form>

      {c.optedOut && <p className="banner warn">Este cliente pidió no recibir más mensajes (baja).</p>}
    </aside>
  );
}

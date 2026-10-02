import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";

export function Login({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo conectar con el servidor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Red Soluciones</h1>
        <p className="muted">Panel de conversaciones de WhatsApp</p>
        {!configured && (
          <p className="banner warn">
            El panel aún no tiene contraseña. Define <code>ADMIN_PASSWORD</code> y <code>SESSION_SECRET</code> en el
            servidor y reinícialo.
          </p>
        )}
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>
    </main>
  );
}

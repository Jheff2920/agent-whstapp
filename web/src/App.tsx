import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { ConversationList } from "./components/ConversationList";
import { CustomerPanel } from "./components/CustomerPanel";
import { Login } from "./components/Login";
import { Thread } from "./components/Thread";
import { Agenda } from "./components/Agenda";
import { TopBar, type View } from "./components/TopBar";
import type { Detail, ListItem, Status } from "./types";

type Auth = "loading" | "login" | "ready";

export function App() {
  const [auth, setAuth] = useState<Auth>("loading");
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setConfigured(r.configured);
        setAuth(r.authenticated ? "ready" : "login");
      })
      .catch(() => setAuth("login"));
  }, []);

  if (auth === "loading") return <p className="splash">Cargando…</p>;
  if (auth === "login") return <Login configured={configured} onDone={() => setAuth("ready")} />;
  return <Panel onLogout={() => api.logout().finally(() => setAuth("login"))} onExpired={() => setAuth("login")} />;
}

function Panel({ onLogout, onExpired }: { onLogout: () => void; onExpired: () => void }) {
  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("todas");
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<number | null>(() => {
    const c = Number(new URLSearchParams(location.search).get("c"));
    return Number.isInteger(c) && c > 0 ? c : null;
  });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [view, setView] = useState<View>("chats");
  const [agendaTick, setAgendaTick] = useState(0);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const filterRef = useRef({ filter, query });
  filterRef.current = { filter, query };

  const guard = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onExpired();
      return err instanceof Error ? err.message : "Error inesperado";
    },
    [onExpired],
  );

  const loadList = useCallback(async () => {
    try {
      const { conversations } = await api.conversations(filterRef.current.filter, filterRef.current.query);
      setItems(conversations);
    } catch (err) {
      guard(err);
    } finally {
      setLoading(false);
    }
  }, [guard]);

  const loadStatus = useCallback(() => api.status().then(setStatus).catch(guard), [guard]);

  const loadDetail = useCallback(
    async (id: number) => {
      try {
        const d = await api.conversation(id);
        if (activeRef.current === id) setDetail(d);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setActiveId(null);
        else guard(err);
      }
    },
    [guard],
  );

  // lista y estado: al cambiar filtro/búsqueda (con retraso al escribir) y cada 20 s como respaldo
  useEffect(() => {
    const t = setTimeout(() => void loadList(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, query, loadList]);
  useEffect(() => {
    void loadStatus();
    const t = setInterval(() => {
      void loadList();
      void loadStatus();
      if (activeRef.current) void loadDetail(activeRef.current);
    }, 20_000);
    return () => clearInterval(t);
  }, [loadList, loadStatus, loadDetail]);

  useEffect(() => {
    setError("");
    if (activeId === null) {
      setDetail(null);
      return;
    }
    void loadDetail(activeId);
  }, [activeId, loadDetail]);

  // tiempo real: el servidor avisa y se vuelve a pedir lo que se está viendo
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingId: number | null = null;
    const es = new EventSource("/api/events");
    const onEvent = (ev: MessageEvent) => {
      const { conversationId } = JSON.parse(ev.data) as { conversationId: number };
      if (ev.type === "agenda") setAgendaTick((n) => n + 1);
      if (conversationId === activeRef.current) pendingId = conversationId;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void loadList();
        void loadStatus();
        if (pendingId !== null) void loadDetail(pendingId);
        pendingId = null;
      }, 250);
    };
    for (const type of ["message", "conversation", "outbox", "agenda"]) es.addEventListener(type, onEvent as EventListener);
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [loadList, loadStatus, loadDetail]);

  useEffect(() => {
    const unread = status?.conversations.unread ?? 0;
    document.title = unread > 0 ? `(${unread}) Red Soluciones · Conversaciones` : "Red Soluciones · Conversaciones";
  }, [status]);

  async function act(fn: () => Promise<Detail>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      setDetail(await fn());
      void loadList();
      void loadStatus();
      return true;
    } catch (err) {
      setError(guard(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const select = (id: number) => {
    setActiveId(id);
    setInfoOpen(false);
    history.replaceState(null, "", `?c=${id}`);
  };

  if (view === "agenda") {
    return (
      <div className="app" data-view="agenda">
        <TopBar status={status} view={view} onView={setView} onLogout={onLogout} />
        <Agenda
          sedesRefresh={agendaTick}
          onExpired={onExpired}
          onOpenChat={(id) => {
            setView("chats");
            select(id);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app" data-view={activeId === null ? "list" : infoOpen ? "info" : "thread"}>
      <TopBar status={status} view={view} onView={setView} onLogout={onLogout} />
      <ConversationList
        items={items}
        activeId={activeId}
        filter={filter}
        query={query}
        loading={loading}
        onFilter={setFilter}
        onQuery={setQuery}
        onSelect={select}
      />
      {detail && activeId !== null ? (
        <>
          <Thread
            detail={detail}
            busy={busy}
            error={error}
            onBack={() => {
              setActiveId(null);
              history.replaceState(null, "", location.pathname);
            }}
            onInfo={() => setInfoOpen(true)}
            onTakeover={() => void act(() => api.takeover(activeId))}
            onRelease={() => void act(() => api.release(activeId))}
            onSend={(text) => act(() => api.send(activeId, text))}
            onNote={(text) => act(() => api.note(activeId, text))}
          />
          <CustomerPanel
            detail={detail}
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            onPatch={async (patch) => void (await act(() => api.patchCustomer(detail.customer.id, patch)))}
            onPutFact={async (k, v) => void (await act(() => api.putFact(detail.customer.id, k, v)))}
            onDeleteFact={async (k) => void (await act(() => api.deleteFact(detail.customer.id, k)))}
          />
        </>
      ) : (
        <section className="placeholder" aria-live="polite">
          <p>{activeId === null ? "Elige una conversación para verla o intervenir." : "Cargando conversación…"}</p>
        </section>
      )}
    </div>
  );
}

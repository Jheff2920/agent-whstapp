import type { DB } from "./db.js";

export type Mode = "bot" | "humano" | "escalado";
export type Author = "cliente" | "bot" | "humano" | "nota";

export interface Customer {
  id: number;
  wa_id: string;
  name: string | null;
  stage: string;
  summary: string | null;
  opted_out: number;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: number;
  customer_id: number;
  mode: Mode;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  unread: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  direction: "in" | "out";
  author: Author;
  body: string;
  wa_message_id: string | null;
  status: string;
  created_at: string;
}

export interface OutboxRow {
  id: number;
  message_id: number;
  to_wa_id: string;
  body: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: number;
  mode: Mode;
  unread: number;
  last_customer_message_at: string | null;
  last_message_at: string | null;
  customer_id: number;
  name: string | null;
  wa_id: string;
  stage: string;
  opted_out: number;
  last_body: string | null;
  last_author: Author | null;
}

export interface ConversationFilter {
  mode?: Mode;
  unreadOnly?: boolean;
  q?: string;
  limit?: number;
}

const now = () => new Date().toISOString();

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class Repo {
  constructor(readonly db: DB) {}

  // ---- clientes y conversaciones ----

  upsertCustomer(waId: string, name?: string | null): Customer {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO customers (wa_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(wa_id) DO UPDATE SET
           name = COALESCE(customers.name, excluded.name),
           updated_at = excluded.updated_at`,
      )
      .run(waId, name ?? null, ts, ts);
    return this.db.prepare("SELECT * FROM customers WHERE wa_id = ?").get(waId) as Customer;
  }

  getCustomer(id: number): Customer | undefined {
    return this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Customer | undefined;
  }

  setCustomerName(id: number, name: string): void {
    this.db.prepare("UPDATE customers SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
  }

  setStage(id: number, stage: string): void {
    this.db.prepare("UPDATE customers SET stage = ?, updated_at = ? WHERE id = ?").run(stage, now(), id);
  }

  setOptedOut(id: number, optedOut: boolean): void {
    this.db
      .prepare("UPDATE customers SET opted_out = ?, updated_at = ? WHERE id = ?")
      .run(optedOut ? 1 : 0, now(), id);
  }

  getOrCreateConversation(customerId: number): Conversation {
    this.db.prepare("INSERT OR IGNORE INTO conversations (customer_id) VALUES (?)").run(customerId);
    return this.db
      .prepare("SELECT * FROM conversations WHERE customer_id = ?")
      .get(customerId) as Conversation;
  }

  getConversation(id: number): Conversation | undefined {
    return this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Conversation | undefined;
  }

  setMode(conversationId: number, mode: Mode): void {
    this.db.prepare("UPDATE conversations SET mode = ? WHERE id = ?").run(mode, conversationId);
  }

  // ---- mensajes ----

  /** Devuelve true si el id es nuevo; false si ya se había procesado (Meta reintenta entregas). */
  markProcessed(waMessageId: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO processed_events (wa_message_id, created_at) VALUES (?, ?)")
      .run(waMessageId, now());
    return r.changes === 1;
  }

  addMessage(m: {
    conversationId: number;
    direction: "in" | "out";
    author: Author;
    body: string;
    waMessageId?: string | null;
    status?: string;
    createdAt?: string;
  }): Message {
    const ts = m.createdAt ?? now();
    const info = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, author, body, wa_message_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.conversationId,
        m.direction,
        m.author,
        m.body,
        m.waMessageId ?? null,
        m.status ?? (m.direction === "in" ? "received" : "queued"),
        ts,
      );
    if (m.author === "cliente") {
      this.db
        .prepare(
          `UPDATE conversations SET last_customer_message_at = ?, last_message_at = ?, unread = unread + 1
           WHERE id = ?`,
        )
        .run(ts, ts, m.conversationId);
    } else if (m.author !== "nota") {
      this.db.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").run(ts, m.conversationId);
    }
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid) as Message;
  }

  /** Últimos mensajes (sin notas internas) en orden cronológico. */
  recentMessages(conversationId: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND author != 'nota'
         ORDER BY id DESC LIMIT ?`,
      )
      .all(conversationId, limit) as Message[];
    return rows.reverse();
  }

  lastMessage(conversationId: number): Message | undefined {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND author != 'nota' ORDER BY id DESC LIMIT 1")
      .get(conversationId) as Message | undefined;
  }

  updateMessageStatusByWaId(waMessageId: string, status: string): void {
    this.db.prepare("UPDATE messages SET status = ? WHERE wa_message_id = ?").run(status, waMessageId);
  }

  // ---- datos recordados del cliente ----

  setFact(customerId: number, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO customer_facts (customer_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(customer_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(customerId, key, value, now());
  }

  getFacts(customerId: number): { key: string; value: string }[] {
    return this.db
      .prepare("SELECT key, value FROM customer_facts WHERE customer_id = ? ORDER BY key")
      .all(customerId) as { key: string; value: string }[];
  }

  // ---- solicitudes de cotización ----

  addQuoteRequest(customerId: number, summary: string): number {
    const info = this.db
      .prepare("INSERT INTO quote_requests (customer_id, summary, created_at) VALUES (?, ?, ?)")
      .run(customerId, summary, now());
    return Number(info.lastInsertRowid);
  }

  // ---- outbox ----

  /** Crea el mensaje saliente y su fila de outbox de forma atómica. */
  enqueueOutbound(o: {
    conversationId: number;
    toWaId: string;
    body: string;
    author: "bot" | "humano";
  }): { message: Message; outboxId: number } {
    return this.db.transaction(() => {
      const message = this.addMessage({
        conversationId: o.conversationId,
        direction: "out",
        author: o.author,
        body: o.body,
        status: "queued",
      });
      const ts = now();
      const info = this.db
        .prepare(
          `INSERT INTO outbox (message_id, to_wa_id, body, next_attempt_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(message.id, o.toWaId, o.body, ts, ts);
      return { message, outboxId: Number(info.lastInsertRowid) };
    })();
  }

  /** ¿La ventana de 24 h de WhatsApp (desde el último mensaje del cliente) sigue abierta? */
  windowOpenForMessage(messageId: number, at: Date = new Date()): boolean {
    const row = this.db
      .prepare(
        `SELECT c.last_customer_message_at AS last FROM messages m
         JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`,
      )
      .get(messageId) as { last: string | null } | undefined;
    if (!row?.last) return false;
    return at.getTime() - new Date(row.last).getTime() < 24 * 60 * 60 * 1000;
  }

  dueOutbox(limit = 10): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id LIMIT ?`,
      )
      .all(now(), limit) as OutboxRow[];
  }

  markOutboxSent(row: OutboxRow, waMessageId: string | null): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE outbox SET status = 'sent', last_error = NULL WHERE id = ?").run(row.id);
      this.db
        .prepare("UPDATE messages SET status = 'sent', wa_message_id = COALESCE(?, wa_message_id) WHERE id = ?")
        .run(waMessageId, row.message_id);
    })();
  }

  markOutboxRetry(row: OutboxRow, error: string, nextAttemptAt: string): void {
    this.db
      .prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?")
      .run(error, nextAttemptAt, row.id);
  }

  markOutboxFailed(row: OutboxRow, error: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?")
        .run(error, row.id);
      this.db.prepare("UPDATE messages SET status = 'failed' WHERE id = ?").run(row.message_id);
    })();
  }

  // ---- consultas del panel ----

  listConversations(f: ConversationFilter = {}): ConversationRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.mode) {
      where.push("c.mode = ?");
      args.push(f.mode);
    }
    if (f.unreadOnly) where.push("c.unread > 0");
    const q = f.q?.trim();
    if (q) {
      const like = `%${likeEscape(q)}%`;
      where.push(
        `(u.name LIKE ? ESCAPE '\\' OR u.wa_id LIKE ? ESCAPE '\\' OR EXISTS
          (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.author != 'nota' AND m.body LIKE ? ESCAPE '\\'))`,
      );
      args.push(like, like, like);
    }
    args.push(Math.min(f.limit ?? 200, 500));
    return this.db
      .prepare(
        `SELECT c.id, c.mode, c.unread, c.last_customer_message_at, c.last_message_at,
                u.id AS customer_id, u.name, u.wa_id, u.stage, u.opted_out,
                (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.author != 'nota' ORDER BY m.id DESC LIMIT 1) AS last_body,
                (SELECT author FROM messages m WHERE m.conversation_id = c.id AND m.author != 'nota' ORDER BY m.id DESC LIMIT 1) AS last_author
         FROM conversations c JOIN customers u ON u.id = c.customer_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY COALESCE(c.last_message_at, '') DESC, c.id DESC LIMIT ?`,
      )
      .all(...args) as ConversationRow[];
  }

  /** Todos los mensajes (incluidas notas internas) en orden cronológico. */
  allMessages(conversationId: number, limit = 300): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
      .all(conversationId, limit) as Message[];
    return rows.reverse();
  }

  markRead(conversationId: number): void {
    this.db.prepare("UPDATE conversations SET unread = 0 WHERE id = ?").run(conversationId);
  }

  updateCustomer(id: number, patch: { name?: string | null; stage?: string; summary?: string | null }): void {
    const sets: string[] = [];
    const args: (string | null | number)[] = [];
    for (const key of ["name", "stage", "summary"] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(patch[key] as string | null);
      }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE customers SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, now(), id);
  }

  deleteFact(customerId: number, key: string): void {
    this.db.prepare("DELETE FROM customer_facts WHERE customer_id = ? AND key = ?").run(customerId, key);
  }

  outboxCounts(): { pending: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM outbox`,
      )
      .get() as { pending: number | null; failed: number | null };
    return { pending: row.pending ?? 0, failed: row.failed ?? 0 };
  }

  conversationCounts(): { escalado: number; humano: number; unread: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(mode = 'escalado') AS escalado, SUM(mode = 'humano') AS humano, SUM(unread > 0) AS unread FROM conversations`,
      )
      .get() as { escalado: number | null; humano: number | null; unread: number | null };
    return { escalado: row.escalado ?? 0, humano: row.humano ?? 0, unread: row.unread ?? 0 };
  }

  conversationIdOfMessage(messageId: number): number | undefined {
    const row = this.db.prepare("SELECT conversation_id AS id FROM messages WHERE id = ?").get(messageId) as
      | { id: number }
      | undefined;
    return row?.id;
  }

  latestQuoteSummary(customerId: number): string | undefined {
    const row = this.db
      .prepare("SELECT summary FROM quote_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 1")
      .get(customerId) as { summary: string } | undefined;
    return row?.summary;
  }
}

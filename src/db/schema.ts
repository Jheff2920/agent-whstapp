// Migraciones secuenciales; el número de versión se guarda en PRAGMA user_version.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    wa_id TEXT NOT NULL UNIQUE,
    name TEXT,
    stage TEXT NOT NULL DEFAULT 'nuevo',
    summary TEXT,
    opted_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id),
    mode TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot','humano','escalado')),
    last_customer_message_at TEXT,
    last_message_at TEXT,
    unread INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    author TEXT NOT NULL CHECK (author IN ('cliente','bot','humano','nota')),
    body TEXT NOT NULL,
    wa_message_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'received',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_conv ON messages(conversation_id, id);

  CREATE TABLE customer_facts (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (customer_id, key)
  );

  CREATE TABLE processed_events (
    wa_message_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE quote_requests (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'abierta',
    created_at TEXT NOT NULL
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    to_wa_id TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
  `,
];

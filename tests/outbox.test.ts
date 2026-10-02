import pino from "pino";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";
import { HttpSender, Outbox } from "../src/outbox.js";
import { CaptureSender } from "./helpers.js";

const log = pino({ level: "silent" });

function seed(opts: { lastCustomerMessage?: Date } = {}) {
  const repo = new Repo(openDb(":memory:"));
  const c = repo.upsertCustomer("51900");
  const conv = repo.getOrCreateConversation(c.id);
  repo.addMessage({
    conversationId: conv.id,
    direction: "in",
    author: "cliente",
    body: "hola",
    createdAt: (opts.lastCustomerMessage ?? new Date()).toISOString(),
  });
  return { repo, conv };
}

describe("Outbox", () => {
  it("envía y marca como enviado guardando el id de WhatsApp", async () => {
    const { repo, conv } = seed();
    const sender = new CaptureSender();
    const outbox = new Outbox(repo, sender, log);
    const { message } = outbox.enqueue({ conversationId: conv.id, toWaId: "51900", body: "hola", author: "bot" });
    await outbox.flush();
    expect(sender.sent).toHaveLength(1);
    const stored = repo.lastMessage(conv.id)!;
    expect(stored.id).toBe(message.id);
    expect(stored.status).toBe("sent");
    expect(stored.wa_message_id).toMatch(/^wamid\.out\./);
  });

  it("reintenta con espera creciente y falla definitivamente tras el máximo de intentos", async () => {
    const { repo, conv } = seed();
    const sender = new CaptureSender();
    sender.failTimes = 99;
    let now = new Date();
    const outbox = new Outbox(repo, sender, log, { maxAttempts: 3, now: () => now });
    outbox.enqueue({ conversationId: conv.id, toWaId: "51900", body: "hola", author: "bot" });
    await outbox.flush();
    expect(repo.dueOutbox()).toHaveLength(0); // en espera hasta el próximo intento
    for (let i = 0; i < 2; i++) {
      now = new Date(now.getTime() + 20 * 60_000);
      const row = repo.db.prepare("SELECT * FROM outbox").get() as any;
      repo.db.prepare("UPDATE outbox SET next_attempt_at = ? WHERE id = ?").run(new Date(0).toISOString(), row.id);
      await outbox.flush();
    }
    const row = repo.db.prepare("SELECT status, attempts FROM outbox").get() as any;
    expect(row).toEqual({ status: "failed", attempts: 3 });
    expect(repo.lastMessage(conv.id)!.status).toBe("failed");
  });

  it("no envía texto libre fuera de la ventana de 24 h", async () => {
    const { repo, conv } = seed({ lastCustomerMessage: new Date(Date.now() - 30 * 3600_000) });
    const sender = new CaptureSender();
    const outbox = new Outbox(repo, sender, log);
    outbox.enqueue({ conversationId: conv.id, toWaId: "51900", body: "seguimiento", author: "bot" });
    await outbox.flush();
    expect(sender.sent).toHaveLength(0);
    const row = repo.db.prepare("SELECT status, last_error FROM outbox").get() as any;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("24 h");
  });
});

describe("HttpSender", () => {
  it("envía JSON con el token interno y lee wa_message_id", async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ wa_message_id: "wamid.X" }), { status: 200 });
    }) as unknown as typeof fetch;
    const sender = new HttpSender("http://n8n/webhook/send", "tok", fake);
    const r = await sender.send({ outboxId: 1, messageId: 2, to: "51900", text: "hola" });
    expect(r.waMessageId).toBe("wamid.X");
    expect(seen.headers["x-internal-token"]).toBe("tok");
    expect(seen.body).toMatchObject({ to: "51900", text: "hola" });
  });
  it("lanza error si n8n responde con fallo", async () => {
    const fake = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(new HttpSender("http://x", "t", fake).send({ outboxId: 1, messageId: 1, to: "1", text: "x" })).rejects.toThrow(
      "500",
    );
  });
});

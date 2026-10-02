import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repos.js";

const fresh = () => new Repo(openDb(":memory:"));

describe("Repo", () => {
  it("deduplica por id de mensaje", () => {
    const repo = fresh();
    expect(repo.markProcessed("w1")).toBe(true);
    expect(repo.markProcessed("w1")).toBe(false);
  });

  it("upsert de cliente conserva el primer nombre y una sola conversación", () => {
    const repo = fresh();
    const a = repo.upsertCustomer("51900", "Ana");
    const b = repo.upsertCustomer("51900", "Otro");
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Ana");
    expect(repo.getOrCreateConversation(a.id).id).toBe(repo.getOrCreateConversation(a.id).id);
  });

  it("historial en orden, sin notas internas, y respeta el límite", () => {
    const repo = fresh();
    const c = repo.upsertCustomer("51900");
    const conv = repo.getOrCreateConversation(c.id);
    for (let i = 1; i <= 5; i++) {
      repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: `m${i}` });
    }
    repo.addMessage({ conversationId: conv.id, direction: "out", author: "nota", body: "interna" });
    expect(repo.recentMessages(conv.id, 3).map((m) => m.body)).toEqual(["m3", "m4", "m5"]);
    expect(repo.getConversation(conv.id)!.unread).toBe(5);
  });

  it("datos recordados se actualizan por clave", () => {
    const repo = fresh();
    const c = repo.upsertCustomer("51900");
    repo.setFact(c.id, "presupuesto", "1000");
    repo.setFact(c.id, "presupuesto", "2000");
    expect(repo.getFacts(c.id)).toEqual([{ key: "presupuesto", value: "2000" }]);
  });

  it("enqueueOutbound crea mensaje y fila de outbox; la ventana de 24 h se calcula", () => {
    const repo = fresh();
    const c = repo.upsertCustomer("51900");
    const conv = repo.getOrCreateConversation(c.id);
    repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: "hola" });
    const { message, outboxId } = repo.enqueueOutbound({
      conversationId: conv.id,
      toWaId: "51900",
      body: "hola!",
      author: "bot",
    });
    expect(repo.dueOutbox().map((r) => r.id)).toEqual([outboxId]);
    expect(repo.windowOpenForMessage(message.id)).toBe(true);
    expect(repo.windowOpenForMessage(message.id, new Date(Date.now() + 25 * 3600_000))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { parseWebhook } from "../src/whatsapp/payload.js";
import { metaPayload } from "./helpers.js";

describe("parseWebhook", () => {
  it("extrae texto y nombre del contacto", () => {
    const { messages } = parseWebhook(metaPayload("wamid.1", "51999", "Hola", "Ana"));
    expect(messages).toEqual([{ waMessageId: "wamid.1", from: "51999", name: "Ana", body: "Hola" }]);
  });
  it("representa mensajes no textuales y descarta reacciones", () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [
        { id: "a", from: "1", type: "audio" },
        { id: "b", from: "1", type: "reaction" },
        { id: "c", from: "1", type: "interactive", interactive: { button_reply: { title: "Sí" } } },
      ] } }] }],
    };
    expect(parseWebhook(payload).messages.map((m) => m.body)).toEqual(["[audio]", "Sí"]);
  });
  it("lee estados de entrega y tolera basura", () => {
    const payload = { entry: [{ changes: [{ value: { statuses: [{ id: "x", status: "delivered" }] } }] }] };
    expect(parseWebhook(payload).statuses).toEqual([{ waMessageId: "x", status: "delivered" }]);
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ entry: "mal" })).toEqual({ messages: [], statuses: [] });
  });
});

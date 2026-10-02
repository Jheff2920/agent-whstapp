import { describe, expect, it } from "vitest";
import { sign, verifySignature } from "../src/whatsapp/signature.js";

describe("firma de Meta", () => {
  it("acepta una firma válida", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifySignature(body, sign(body, "s"), "s")).toBe(true);
  });
  it("rechaza cuerpo alterado, secreto distinto o cabecera ausente/malformada", () => {
    const body = JSON.stringify({ a: 1 });
    const good = sign(body, "s");
    expect(verifySignature(body + " ", good, "s")).toBe(false);
    expect(verifySignature(body, good, "otro")).toBe(false);
    expect(verifySignature(body, undefined, "s")).toBe(false);
    expect(verifySignature(body, "md5=abc", "s")).toBe(false);
    expect(verifySignature(body, "sha256=corto", "s")).toBe(false);
  });
});

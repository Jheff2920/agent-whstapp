import crypto from "node:crypto";

/** Valida X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con el App Secret de Meta). */
export function verifySignature(raw: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(expected, header.slice("sha256=".length));
}

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function sign(raw: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

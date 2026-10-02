import fs from "node:fs";
import { describe, expect, it } from "vitest";

const load = (name: string) =>
  JSON.parse(fs.readFileSync(new URL(`../n8n/workflows/${name}.json`, import.meta.url), "utf8")) as {
    nodes: { name: string; type: string; parameters: Record<string, any> }[];
    connections: Record<string, { main: { node: string }[][] }>;
  };

const byName = (wf: ReturnType<typeof load>, name: string) => wf.nodes.find((n) => n.name === name)!;

describe("workflows de n8n versionados", () => {
  const entrada = load("whatsapp-entrada");
  const salida = load("whatsapp-salida");

  it("todas las conexiones apuntan a nodos que existen", () => {
    for (const wf of [entrada, salida]) {
      const names = new Set(wf.nodes.map((n) => n.name));
      for (const [from, out] of Object.entries(wf.connections)) {
        expect(names.has(from), from).toBe(true);
        for (const branch of out.main) for (const c of branch) expect(names.has(c.node), c.node).toBe(true);
      }
    }
  });

  it("entrada: verifica a Meta por GET y reenvía el cuerpo crudo con la firma al cerebro", () => {
    const get = byName(entrada, "Meta verifica el webhook (GET)");
    const post = byName(entrada, "Mensajes y estados de WhatsApp (POST)");
    expect(get.parameters.httpMethod).toBe("GET");
    expect(post.parameters.httpMethod).toBe("POST");
    expect(get.parameters.path).toBe(post.parameters.path);
    // la firma de Meta se calcula sobre los bytes exactos: cuerpo crudo y envío binario
    expect(post.parameters.options.rawBody).toBe(true);
    const fwd = byName(entrada, "Reenviar al cerebro");
    expect(fwd.parameters.url).toMatch(/\/api\/inbound$/);
    expect(fwd.parameters.contentType).toBe("binaryData");
    const headers = fwd.parameters.headerParameters.parameters.map((h: any) => h.name);
    expect(headers).toContain("X-Hub-Signature-256");
    // la cabecera X-Internal-Token la pone la credencial, no el workflow
    expect(fwd.parameters.genericAuthType).toBe("httpTemplatedCustomAuth");
    expect(JSON.stringify(entrada)).not.toMatch(/X-Internal-Token":\s*"[^{]/);
  });

  it("entrada: si el cerebro falla responde 500 (Meta reintenta) y si va bien responde 200", () => {
    const out = entrada.connections["Reenviar al cerebro"]!.main;
    expect(out[0]![0]!.node).toBe("Responder 200 a Meta");
    expect(out[1]![0]!.node).toBe("Responder 500 (Meta reintentará)");
    expect(byName(entrada, "Responder 500 (Meta reintentará)").parameters.options.responseCode).toBe(500);
  });

  it("salida: lee los mismos campos que envía el cerebro (to y text) y se autentica con la cabecera interna", () => {
    const send = byName(salida, "Enviar mensaje por WhatsApp");
    expect(send.parameters.recipientPhoneNumber).toBe("={{ $json.body.to }}");
    expect(send.parameters.textBody).toBe("={{ $json.body.text }}");
    const hook = byName(salida, "El cerebro pide enviar un mensaje");
    expect(hook.parameters.authentication).toBe("headerAuth");
    expect(hook.parameters.path).toBe("red-whatsapp-enviar");
    expect(byName(salida, "Devolver el id del mensaje").parameters.responseBody).toContain("wa_message_id");
    expect(byName(salida, "Informar fallo de envío").parameters.options.responseCode).toBe(502);
  });

  it("alerta: se autentica con la cabecera interna y usa los campos que envía el cerebro", () => {
    const alerta = load("whatsapp-alerta");
    const names = new Set(alerta.nodes.map((n) => n.name));
    for (const [from, out] of Object.entries(alerta.connections)) {
      expect(names.has(from)).toBe(true);
      for (const branch of out.main) for (const c of branch) expect(names.has(c.node)).toBe(true);
    }
    const hook = byName(alerta, "El cerebro envía una alerta");
    expect(hook.parameters.authentication).toBe("headerAuth");
    expect(hook.parameters.path).toBe("red-whatsapp-alerta");
    const mail = byName(alerta, "Avisar al asesor por correo");
    const template = JSON.stringify(mail.parameters);
    // los campos del AlertPayload del cerebro (src/notify.ts) y los tres tipos de alerta
    for (const field of ["type", "customerName", "waId", "reason", "lastMessage", "panelUrl"]) {
      expect(template, field).toContain(`$json.body.${field}`);
    }
    for (const type of ["escalado", "mensaje_pendiente", "cotizacion"]) expect(template, type).toContain(type);
    expect(byName(alerta, "Informar fallo de la alerta").parameters.options.responseCode).toBe(502);
  });

  it("no hay secretos en los workflows", () => {
    const all = JSON.stringify([entrada, salida, load("whatsapp-alerta")]);
    expect(all).not.toMatch(/EAA[A-Za-z0-9]{20,}/); // token de acceso de Meta
    expect(all).not.toMatch(/sk-ant-/);
  });
});

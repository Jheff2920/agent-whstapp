import { PermanentSendError, type SendRequest, type Sender } from "../outbox.js";

export interface CloudApiOptions {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Códigos de error de Graph que significan "reintenta más tarde" (límites de velocidad). */
const TRANSIENT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131056]);

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number };
  messages?: { id?: string }[];
}

/** Envía mensajes de texto directamente por la WhatsApp Cloud API de Meta. */
export class CloudApiSender implements Sender {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: CloudApiOptions) {
    this.url = `${(o.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${o.graphVersion}/${o.phoneNumberId}/messages`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async send(req: SendRequest): Promise<{ waMessageId?: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.accessToken}` },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: req.to,
          ...(req.template
            ? {
                type: "template",
                template: {
                  name: req.template.name,
                  language: { code: req.template.lang },
                  components: req.template.params.length
                    ? [{ type: "body", parameters: req.template.params.map((text) => ({ type: "text", text })) }]
                    : [],
                },
              }
            : { type: "text", text: { preview_url: false, body: req.text } }),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // red caída o tiempo agotado: se reintenta
      throw new Error(`No se pudo contactar con WhatsApp: ${(err as Error).message}`);
    }

    const data = (await res.json().catch(() => ({}))) as GraphError;
    if (res.ok) return { waMessageId: data.messages?.[0]?.id };

    const code = data.error?.code;
    const detail = data.error?.message ?? res.statusText;
    const message = `WhatsApp ${res.status}${code ? ` (código ${code})` : ""}: ${detail}`;
    const transient = res.status >= 500 || res.status === 429 || (code !== undefined && TRANSIENT_CODES.has(code));
    throw transient ? new Error(message) : new PermanentSendError(message);
  }
}

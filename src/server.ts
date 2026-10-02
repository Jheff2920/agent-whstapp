import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { Repo } from "./db/repos.js";
import type { ConversationService } from "./conversation.js";
import { parseWebhook } from "./whatsapp/payload.js";
import { safeEqual, verifySignature } from "./whatsapp/signature.js";

export interface AppDeps {
  cfg: Config;
  repo: Repo;
  conversations: ConversationService;
  log: Logger;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { cfg, repo, conversations, log } = deps;
  const app = Fastify({ loggerInstance: log as FastifyBaseLogger, bodyLimit: 1_000_000 }) as unknown as FastifyInstance;

  // Conservamos el cuerpo crudo: la firma de Meta se calcula sobre los bytes exactos.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));

  /**
   * Procesa un webhook de Meta. `requireToken` es para /api/inbound (n8n); /webhook lo llama Meta directamente,
   * así que solo se autentica por la firma X-Hub-Signature-256.
   */
  const handleInbound = (requireToken: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (requireToken && cfg.internalToken && !safeEqual(req.headers["x-internal-token"] as string | undefined, cfg.internalToken)) {
      return reply.code(401).send({ error: "token interno inválido" });
    }
    if (cfg.waAppSecret) {
      const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
      if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined, cfg.waAppSecret)) {
        return reply.code(401).send({ error: "firma inválida" });
      }
    }

    const { messages, statuses } = parseWebhook(req.body);
    for (const s of statuses) repo.updateMessageStatusByWaId(s.waMessageId, s.status);
    for (const m of messages) conversations.ingest(m);
    return reply.code(202).send({ accepted: messages.length });
  };

  // Ruta de n8n: solo existe si hay token interno (en producción sin token no se expone).
  if (cfg.internalToken || cfg.nodeEnv !== "production") app.post("/api/inbound", handleInbound(true));

  // Rutas de Meta (modo directo): verificación del webhook y recepción de mensajes y estados.
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (
      cfg.waVerifyToken &&
      q["hub.mode"] === "subscribe" &&
      safeEqual(q["hub.verify_token"], cfg.waVerifyToken) &&
      q["hub.challenge"]
    ) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("verificación rechazada");
  });
  app.post("/webhook", handleInbound(false));

  return app;
}

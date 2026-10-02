import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { registerPanelApi, type PanelDeps } from "./api.js";

/**
 * Panel de gestión: va en su propio puerto (por defecto solo en localhost) para que el túnel público
 * solo exponga /api/inbound y /health del cerebro.
 */
export async function buildPanelApp(deps: PanelDeps & { log: Logger; webDir?: string }): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.log as FastifyBaseLogger, bodyLimit: 100_000 }) as unknown as FastifyInstance;
  registerPanelApi(app, deps);

  const webDir = deps.webDir ?? path.resolve("web/dist");
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: webDir });
    // Aplicación de una sola página: cualquier ruta que no sea /api devuelve index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.type("text/html").sendFile("index.html");
      return reply.code(404).send({ error: "no encontrado" });
    });
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/plain").send("Panel sin compilar: ejecuta `npm run web:build` (o `npm run web:dev` para desarrollo)."),
    );
  }
  return app;
}

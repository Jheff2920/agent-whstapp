import readline from "node:readline/promises";
import { Agent } from "./agent/agent.js";
import { AppointmentService } from "./appointments/service.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/db.js";
import { Repo } from "./db/repos.js";
import { KnowledgeStore } from "./knowledge/loader.js";
import { createProvider } from "./llm/index.js";

// Simula a un cliente por terminal con el mismo agente que usa WhatsApp (sin n8n ni Meta).
const cfg = loadConfig();
const repo = new Repo(openDb(process.env.CHAT_DB ?? "./data/chat.db"));
const knowledge = new KnowledgeStore(cfg.knowledgeDir);
const provider = createProvider(cfg);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let waId = "chat-local";
const appointments = new AppointmentService(repo, () => knowledge.get().sedes);
const agent = new Agent({
  provider,
  repo,
  knowledge,
  cfg,
  appointments,
  onTool: (name, input, output, isError) =>
    console.log(dim(`  [tool ${name}${isError ? " ERROR" : ""}] ${JSON.stringify(input)} -> ${output.slice(0, 160)}`)),
});

console.log(`Modelo: ${provider.name} / ${provider.model}`);
const k = knowledge.get();
if (k.pending.length) console.log(dim(`Conocimiento incompleto (knowledge/): ${k.pending.join(", ")}`));
console.log(dim("Comandos: /reset  /facts  /mode  /bot  /exit\n"));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "Tú: " });
rl.prompt();
// Iteración asíncrona: encola las líneas que llegan mientras el modelo responde (también con stdin por tubería).
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    rl.prompt();
    continue;
  }
  if (line === "/exit") break;
  await handle(line);
  rl.prompt();
}
rl.close();

async function handle(line: string): Promise<void> {
  const customer = repo.upsertCustomer(waId, "Cliente de prueba");
  const conv = repo.getOrCreateConversation(customer.id);

  if (line === "/reset") {
    waId = `chat-${Date.now()}`;
    console.log(dim("Nuevo cliente de prueba.\n"));
    return;
  }
  if (line === "/facts") {
    console.log(dim(JSON.stringify({ etapa: customer.stage, datos: repo.getFacts(customer.id) }, null, 2)));
    return;
  }
  if (line === "/mode") {
    console.log(dim(`modo: ${conv.mode}`));
    return;
  }
  if (line === "/bot") {
    repo.setMode(conv.id, "bot");
    console.log(dim("modo: bot"));
    return;
  }

  repo.addMessage({ conversationId: conv.id, direction: "in", author: "cliente", body: line });
  if (conv.mode !== "bot") {
    console.log(dim("(conversación escalada: en producción el bot no respondería. Usa /bot o /reset)\n"));
    return;
  }
  const started = Date.now();
  try {
    const result = await agent.reply(conv.id);
    repo.addMessage({ conversationId: conv.id, direction: "out", author: "bot", body: result.text, status: "sent" });
    console.log(`Bot: ${result.text}`);
    console.log(dim(`  (${((Date.now() - started) / 1000).toFixed(1)} s${result.handoff ? " · escalado a humano" : ""})\n`));
  } catch (err) {
    console.log(`Error del modelo: ${(err as Error).message}\n`);
  }
}

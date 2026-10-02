import { z } from "zod";
import type { Repo } from "../db/repos.js";
import { searchCatalog, type Knowledge } from "../knowledge/loader.js";
import type { ToolSpec } from "../llm/types.js";

export const LEAD_STAGES = [
  "nuevo",
  "interesado",
  "cotizando",
  "cita_agendada",
  "cerrado_ganado",
  "cerrado_perdido",
] as const;

export interface ToolState {
  handoff: boolean;
  handoffReason?: string;
}

export interface ToolContext {
  repo: Repo;
  knowledge: Knowledge;
  conversationId: number;
  customerId: number;
  state: ToolState;
}

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  run(input: any): string | Promise<string>;
}

function defineTool<S extends z.ZodType>(t: {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>): string | Promise<string>;
}): ToolDef {
  return t;
}

export function toToolSpec(tool: ToolDef): ToolSpec {
  const parameters = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete parameters.$schema;
  return { name: tool.name, description: tool.description, parameters };
}

export function buildTools(ctx: ToolContext): ToolDef[] {
  const { repo, knowledge, conversationId, customerId, state } = ctx;

  return [
    defineTool({
      name: "search_catalog",
      description:
        "Busca productos o servicios en el catálogo oficial de la empresa. Úsala antes de afirmar algo sobre " +
        "productos, precios o características. Devuelve solo lo que existe en el catálogo.",
      schema: z.object({ query: z.string().min(2).describe("Palabras clave de lo que busca el cliente") }),
      run: ({ query }) => {
        const items = searchCatalog(knowledge.catalog, query);
        return items.length
          ? JSON.stringify(items)
          : "Sin resultados en el catálogo. No inventes: ofrece confirmarlo con un asesor.";
      },
    }),

    defineTool({
      name: "remember_fact",
      description:
        "Guarda un dato útil y duradero del cliente (nombre, empresa, necesidad, presupuesto, preferencia, " +
        "objeción). Una llamada por dato. Si la clave ya existe se actualiza.",
      schema: z.object({
        key: z
          .string()
          .min(2)
          .max(40)
          .describe("Nombre corto en snake_case, p. ej. nombre, necesidad, presupuesto"),
        value: z.string().min(1).max(300),
      }),
      run: ({ key, value }) => {
        const k = key.trim().toLowerCase().replace(/\s+/g, "_");
        repo.setFact(customerId, k, value.trim());
        if (k === "nombre") repo.setCustomerName(customerId, value.trim());
        return "Guardado.";
      },
    }),

    defineTool({
      name: "update_lead_stage",
      description: "Actualiza la etapa comercial del cliente según cómo avance la conversación.",
      schema: z.object({ stage: z.enum(LEAD_STAGES) }),
      run: ({ stage }) => {
        repo.setStage(customerId, stage);
        return `Etapa actualizada a ${stage}.`;
      },
    }),

    defineTool({
      name: "create_quote_request",
      description:
        "Registra que el cliente pidió una cotización o propuesta para que un asesor la prepare. " +
        "Incluye en el resumen qué quiere, cantidades y cualquier detalle que haya dado.",
      schema: z.object({ summary: z.string().min(5).max(800) }),
      run: ({ summary }) => {
        const id = repo.addQuoteRequest(customerId, summary);
        repo.setStage(customerId, "cotizando");
        repo.addMessage({
          conversationId,
          direction: "out",
          author: "nota",
          body: `Solicitud de cotización #${id}: ${summary}`,
          status: "internal",
        });
        return `Solicitud #${id} registrada; un asesor la revisará.`;
      },
    }),

    defineTool({
      name: "handoff_to_human",
      description:
        "Pasa la conversación a una persona. Úsala si el cliente lo pide, hay un reclamo, la información " +
        "no está en el conocimiento de la empresa, o no puedes resolver la consulta. Después avisa al cliente " +
        "que un asesor le escribirá.",
      schema: z.object({ reason: z.string().min(3).max(300).describe("Motivo breve para el asesor") }),
      run: ({ reason }) => {
        state.handoff = true;
        state.handoffReason = reason;
        repo.setMode(conversationId, "escalado");
        repo.addMessage({
          conversationId,
          direction: "out",
          author: "nota",
          body: `Escalado a humano: ${reason}`,
          status: "internal",
        });
        return "Conversación escalada. Avisa al cliente que un asesor le escribirá pronto.";
      },
    }),
  ];
}

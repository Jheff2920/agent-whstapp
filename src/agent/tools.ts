import { z } from "zod";
import type { AppointmentService } from "../appointments/service.js";
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
  /** Si está activo, se ofrecen las herramientas de citas. */
  appointments?: AppointmentService;
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
  const { repo, knowledge, conversationId, customerId, state, appointments } = ctx;

  const base: ToolDef[] = [
    defineTool({
      name: "search_catalog",
      description:
        "Busca productos o servicios en el catálogo oficial de la empresa. Úsala antes de afirmar algo sobre " +
        "productos, precios o características. Devuelve solo lo que existe en el catálogo.",
      schema: z.object({
        query: z.string().min(2).describe("Modelo (p. ej. RED-E803B) o palabras clave (p. ej. lector inalámbrico 2D)"),
        max_resultados: z.number().int().min(1).max(15).optional().describe("Por defecto 6"),
      }),
      run: ({ query, max_resultados }) => {
        const items = searchCatalog(knowledge.catalog, query, max_resultados ?? 6).map((item) => {
          const { pagina_catalogo: _page, ...rest } = item;
          return rest;
        });
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

  return appointments?.enabled ? [...base, ...appointmentTools(ctx, appointments)] : base;
}

const FECHA = z.string().describe("Fecha AAAA-MM-DD (hora de Lima). Calcúlala con la fecha actual indicada en el contexto");
const HORA = z.string().describe("Hora de inicio HH:MM en 24 h, exactamente como la devolvió check_availability");

function appointmentTools({ repo, conversationId, customerId }: ToolContext, svc: AppointmentService): ToolDef[] {
  const note = (body: string) =>
    repo.addMessage({ conversationId, direction: "out", author: "nota", body, status: "internal" });

  return [
    defineTool({
      name: "check_availability",
      description:
        "Consulta los horarios libres para visitar una sede. Sin fecha devuelve los próximos días con cupo. " +
        "Es la única fuente válida de horarios: no ofrezcas horas que esta herramienta no haya devuelto.",
      schema: z.object({
        sede: z.string().min(2).describe("Sede que eligió el cliente (nombre o id)"),
        fecha: FECHA.optional(),
      }),
      run: ({ sede, fecha }) => svc.availability(sede, fecha).text,
    }),

    defineTool({
      name: "book_appointment",
      description:
        "Reserva una cita en tienda. Solo después de haber consultado check_availability, de resumir al cliente " +
        "sede, fecha, hora y nombre, y de que haya respondido que sí. Pasa cliente_confirmo=true solo en ese caso.",
      schema: z.object({
        sede: z.string().min(2),
        fecha: FECHA,
        hora: HORA,
        nombre: z.string().min(2).max(80).describe("Nombre de quien visitará la tienda"),
        motivo: z.string().max(200).optional().describe("Para qué viene (p. ej. ver impresoras, recoger un pedido)"),
        cliente_confirmo: z.boolean().describe("true solo si el cliente aceptó explícitamente el resumen"),
      }),
      run: ({ sede, fecha, hora, nombre, motivo, cliente_confirmo }) => {
        if (!cliente_confirmo) {
          return "No reservada: primero resume sede, fecha, hora y nombre al cliente y espera su confirmación explícita.";
        }
        const r = svc.book({ customerId, conversationId, sede, fecha, hora, nombre, motivo });
        if (r.ok) {
          repo.setStage(customerId, "cita_agendada");
          note(`Cita #${r.value.id} agendada: ${r.text}`);
          return `${r.text} Confirma al cliente con estos datos exactos.`;
        }
        return `No se pudo reservar (${r.code}): ${r.text}`;
      },
    }),

    defineTool({
      name: "my_appointments",
      description: "Lista las citas próximas de este cliente (con su número), para consultarlas, cambiarlas o cancelarlas.",
      schema: z.object({}),
      run: () => svc.listText(customerId),
    }),

    defineTool({
      name: "cancel_appointment",
      description: "Cancela una cita del cliente. Úsala solo si el cliente lo pidió claramente.",
      schema: z.object({ id: z.number().int().describe("Número de la cita (de my_appointments)") }),
      run: ({ id }) => {
        const r = svc.cancel(id, { customerId });
        if (r.ok) note(r.text);
        return r.ok ? `${r.text} Confírmalo al cliente.` : `No se pudo cancelar (${r.code}): ${r.text}`;
      },
    }),

    defineTool({
      name: "reschedule_appointment",
      description:
        "Cambia la fecha u hora de una cita existente en la misma sede. Antes consulta check_availability, " +
        "resume el cambio y espera el sí del cliente. Para cambiar de sede: cancela y reserva de nuevo.",
      schema: z.object({
        id: z.number().int(),
        fecha: FECHA,
        hora: HORA,
        cliente_confirmo: z.boolean().describe("true solo si el cliente aceptó explícitamente el cambio"),
      }),
      run: ({ id, fecha, hora, cliente_confirmo }) => {
        if (!cliente_confirmo) return "No cambiada: primero resume el cambio al cliente y espera su confirmación explícita.";
        const r = svc.reschedule(id, { fecha, hora, customerId });
        if (r.ok) note(r.text);
        return r.ok ? `${r.text} Confírmalo al cliente.` : `No se pudo cambiar (${r.code}): ${r.text}`;
      },
    }),
  ];
}

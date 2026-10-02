import type { z } from "zod";

/** Definición de herramienta en JSON Schema, independiente del proveedor. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/**
 * Historial neutral. `raw` guarda el contenido original del asistente cuando el proveedor
 * lo necesita de vuelta intacto (p. ej. bloques de razonamiento de Claude dentro de un mismo turno).
 */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface CompleteRequest {
  /** `stable` casi nunca cambia (se cachea); `volatile` cambia por cliente/turno. */
  system: { stable: string; volatile: string };
  turns: Turn[];
  tools: ToolSpec[];
  maxTokens?: number;
}

export interface CompleteResponse {
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  /** El modelo se negó a responder por políticas de seguridad. */
  refused?: boolean;
}

export interface GenerateObjectRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}

export interface LLMProvider {
  readonly name: "ollama" | "anthropic";
  readonly model: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;
}

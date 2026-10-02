import { DEFAULT_MODELS, type Config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import type { LLMProvider } from "./types.js";

export function createProvider(cfg: Config, which: "ollama" | "anthropic" = cfg.llmProvider): LLMProvider {
  // LLM_MODEL aplica solo al proveedor principal; el de aprendizaje usa su modelo por defecto.
  const model = which === cfg.llmProvider ? (cfg.llmModel ?? DEFAULT_MODELS[which]) : DEFAULT_MODELS[which];
  if (which === "anthropic") {
    return new AnthropicProvider({
      apiKey: cfg.anthropicApiKey,
      model,
      effort: cfg.anthropicEffort,
      fallbacks: cfg.anthropicFallbacks,
    });
  }
  return new OllamaProvider({
    url: cfg.ollamaUrl,
    model,
    think: cfg.ollamaThink,
    timeoutMs: cfg.ollamaTimeoutMs,
  });
}

export type { LLMProvider } from "./types.js";

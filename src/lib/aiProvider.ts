import type { Settings } from "./types";

export function activeModel(settings: Settings, insight = false): string {
  return settings.aiProvider === "codex"
    ? (insight && settings.codexInsightModel) || settings.codexModel || "Codex"
    : (insight && settings.insightModel) || settings.model;
}

export function providerOptions(settings: Settings, options: {
  insight?: boolean;
  model?: string;
  temperature?: number;
  web?: boolean;
  schema?: object;
} = {}) {
  const apiModel = (options.insight && settings.insightModel) || settings.model;
  const codexModel = (options.insight && settings.codexInsightModel) || settings.codexModel;
  const explicit = options.model && options.model !== "Codex" ? options.model : "";
  const codex = settings.aiProvider === "codex";
  return {
    baseUrl: settings.baseUrl,
    model: codex ? apiModel : explicit || apiModel,
    temperature: options.temperature ?? settings.temperature,
    apiFallback: codex && settings.codexApiFallback,
    codex: codex ? {
      path: settings.codexPath,
      model: explicit || codexModel,
      effort: settings.codexEffort,
      timeoutSec: settings.codexTimeoutSec,
      web: options.web ?? false,
      schema: options.schema ?? null,
    } : null,
  };
}

export function migrateProvider(loaded: Partial<Settings>): Settings["aiProvider"] {
  if (loaded.aiProvider === "codex" || loaded.aiProvider === "api") return loaded.aiProvider;
  return loaded.model?.trim() || loaded.baseUrl && loaded.baseUrl !== "https://api.openai.com/v1" ? "api" : "codex";
}

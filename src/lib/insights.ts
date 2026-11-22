import { providerOptions } from "./aiProvider";
import { CancelledError, streamChat } from "./api";
import { buildInsightMessage } from "./prompts";
import type { InsightResult, InsightSource, InsightVerdict, Settings } from "./types";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    verdict: { type: "string", enum: ["supported", "contradicted", "mixed", "unverified"] },
    sources: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { url: { type: "string" } }, required: ["url"],
    } },
  },
  required: ["text", "verdict", "sources"],
};

const factPrompt = "Seçili iddiayı canlı web aramasıyla doğrula. Birincil kaynakları tercih et. 2–4 Türkçe cümlede kanıtı ve belirsizliği açıkla. Yalnızca araç sonuçlarında görünen tam URL'leri sources alanına koy. Kanıt yetersizse verdict unverified. Sonuç metnine kaynak listesi veya URL yazma.";
const explainPrompt = "Seçili kavramı ve bağlamdaki anlamını canlı web aramasıyla 2–4 Türkçe cümlede açıkla. Birincil kaynakları tercih et. Yalnızca araç sonuçlarında görünen tam URL'leri sources alanına koy. Sonuç metnine kaynak listesi veya URL yazma. verdict alanı unverified olsun.";

const unverifiedText = "Bu iddia canlı web kaynaklarıyla doğrulanamadı.";

function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function urlOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function resolveInsight(text: string, events: string[], kind: "explain" | "factcheck"): Pick<InsightResult, "text" | "sources" | "verdict"> {
  const reply = json(text);
  const evidence = new Map<string, InsightSource>();
  for (const raw of events) {
    const event = json(raw);
    if (event?.type !== "web_search" || !Array.isArray(event.results)) continue;
    for (const result of event.results) {
      const url = urlOf(result?.url);
      if (url) evidence.set(url, { url, title: typeof result.title === "string" ? result.title : new URL(url).hostname });
    }
  }
  const cited = Array.isArray(reply?.sources)
    ? reply.sources.map((source: { url?: unknown } | null) => urlOf(source?.url))
    : Array.from(text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g), ([, url]) => urlOf(url));
  const sources: InsightSource[] = [];
  for (const url of new Set<string | null>(cited)) {
    const source = url && evidence.get(url);
    if (source) sources.push(source);
  }
  const verdicts: InsightVerdict[] = ["supported", "contradicted", "mixed"];
  const verdict = kind === "factcheck"
    ? sources.length && verdicts.includes(reply?.verdict) ? reply.verdict as InsightVerdict : "unverified"
    : undefined;
  const message = typeof reply?.text === "string" ? reply.text : text;
  return {
    text: kind === "factcheck" && verdict === "unverified" ? unverifiedText : message.trim(),
    sources,
    verdict,
  };
}

export function runInsightRequest(settings: Settings, kind: "explain" | "factcheck", model: string, quote: string, context: string) {
  const user = buildInsightMessage(quote, context);
  if (settings.aiProvider === "api" && kind === "factcheck") {
    return { done: Promise.resolve({ text: unverifiedText + " Canlı arama için Codex CLI sağlayıcısını seçin.", verdict: "unverified" as const }), cancel: () => {} };
  }
  const web = settings.aiProvider === "codex";
  const events: string[] = [];
  const handle = streamChat({
    ...providerOptions(settings, { insight: true, model, web, schema: web ? schema : undefined }),
    system: web ? kind === "factcheck" ? factPrompt : explainPrompt : settings.insightPrompt,
    user,
    onSearch: (item) => events.push(item),
  });
  return {
    done: handle.done.then(
      (text) => web ? resolveInsight(text, events, kind) : { text: text.trim() },
      (error) => {
        if (kind === "factcheck" && !(error instanceof CancelledError)) {
          return { text: unverifiedText, verdict: "unverified" as const };
        }
        throw error;
      },
    ),
    cancel: handle.cancel,
  };
}

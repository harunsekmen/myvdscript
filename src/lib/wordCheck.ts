import { streamChat } from "./api";
import { WORD_CHECK_PROMPT } from "./prompts";
import { fmtTime, wordNumbers } from "./timed";
import type { Settings, TimedDoc } from "./types";

const CHUNK_WORDS = 180;

export interface WordRef {
  n: number;
  id: string;
  w: string;
  s: number;
}

/** Model yanıtından önerileri ayıklar: { kelimeKimliği: önerilenMetin }. Geçersizler atlanır. */
export function parseFixes(text: string, words: WordRef[]): Record<string, string> {
  const out: Record<string, string> = {};
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let fixes: unknown;
  try {
    fixes = (JSON.parse(text.slice(start, end + 1)) as { fixes?: unknown }).fixes;
  } catch {
    return out;
  }
  if (!Array.isArray(fixes)) return out;
  const byN = new Map(words.map((w) => [w.n, w]));
  for (const f of fixes as { n?: unknown; to?: unknown }[]) {
    const w = byN.get(Number(f.n));
    const to = typeof f.to === "string" ? f.to.trim() : "";
    if (!w || !to || to === w.w) continue;
    out[w.id] = to;
  }
  return out;
}

/**
 * Zamanlı metni parçalar halinde AI'a gönderir ve kelime düzeltme önerilerini toplar.
 * onProgress(tamamlanan, toplam) her parçadan sonra çağrılır.
 */
export async function checkWords(
  doc: TimedDoc,
  s: Settings,
  onProgress: (done: number, total: number) => void,
): Promise<Record<string, string>> {
  const words = wordNumbers(doc.items);
  const chunks: WordRef[][] = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS) chunks.push(words.slice(i, i + CHUNK_WORDS));
  const all: Record<string, string> = {};
  onProgress(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const lines = chunks[i].map((w) => `${w.n} [${fmtTime(w.s, 1)}] ${w.w}`).join("\n");
    const text = await streamChat({
      baseUrl: s.baseUrl,
      model: s.model,
      system: WORD_CHECK_PROMPT,
      user: `Kelimeler:\n${lines}`,
      temperature: 0,
    }).done;
    Object.assign(all, parseFixes(text, chunks[i]));
    onProgress(i + 1, chunks.length);
  }
  return all;
}

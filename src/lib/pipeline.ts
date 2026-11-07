import { api, streamChat, type StreamHandle } from "./api";
import { buildChunkMessage } from "./prompts";
import { chunkText, parseSegments } from "./segmentParser";
import type { Segment, Settings } from "./types";

export interface Progress {
  done: number;
  total: number;
}

export interface PipelineRun {
  promise: Promise<Segment[]>;
  cancel: () => void;
}

/** Altyazıyı parçalara bölüp sırayla AI'a gönderir; her delta'da canlı segmentleri bildirir. */
export function processTranscript(
  transcript: string,
  s: Settings,
  onSegments: (segs: Segment[]) => void,
  onProgress: (p: Progress) => void,
): PipelineRun {
  let current: StreamHandle | null = null;
  let cancelled = false;

  const promise = (async () => {
    const chunks = chunkText(transcript, s.chunkChars);
    const system = s.systemPrompt;
    let acc = "";
    onProgress({ done: 0, total: chunks.length });
    for (let i = 0; i < chunks.length; i++) {
      if (cancelled) throw new Error("İptal edildi");
      const prev = parseSegments(acc);
      const prevTitle = prev.length ? prev[prev.length - 1].title : null;
      const base = acc ? acc + "\n\n" : "";
      current = streamChat({
        baseUrl: s.baseUrl,
        model: s.model,
        system,
        user: buildChunkMessage(chunks[i], prevTitle, i, chunks.length),
        temperature: s.temperature,
        onText: (full) => onSegments(parseSegments(base + full)),
      });
      const out = await current.done;
      acc = base + out.trim();
      onSegments(parseSegments(acc));
      onProgress({ done: i + 1, total: chunks.length });
    }
    return parseSegments(acc);
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      current?.cancel();
    },
  };
}

export { api };

import { streamChat, type StreamHandle } from "./api";
import { buildStyleSystemPrompt } from "./styleReferences";
import { buildChunkMessage } from "./prompts";
import { chunkText, parseSegments } from "./segmentParser";
import type { Segment, Settings } from "./types";

export interface Progress {
  done: number;
  total: number;
}

/** Hata ya da iptal sonrası kaldığı yerden devam edebilmek için gereken durum. */
export interface ResumeState {
  transcript: string;
  /** İşlemin başladığı andaki ayarlar (özel istemle birleştirilmiş sistem istemi, parça boyutu, model…). */
  settings: Settings;
  /** Tamamlanan parçaların birleşik çıktısı. */
  acc: string;
  /** Sıradaki (başarısız olan) parçanın indeksi. */
  next: number;
}

/** İşlem hata/iptal ile bittiğinde fırlatılır; kısmi sonuç ve devam durumu taşır. */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly cancelled: boolean,
    public readonly partial: Segment[],
    public readonly resume: ResumeState,
  ) {
    super(message);
  }
}

export interface PipelineRun {
  promise: Promise<Segment[]>;
  cancel: () => void;
}

export interface PipelineDeps {
  chat: typeof streamChat;
  sleep: (ms: number) => Promise<void>;
}

/** Parça başına yeniden deneme beklemeleri (ms): ilk hatadan sonra 2 sn, ikincisinden sonra 5 sn. */
export const RETRY_DELAYS = [2000, 5000];

const CANCEL_MSG = "İptal edildi";

const realDeps: PipelineDeps = {
  chat: streamChat,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Altyazıyı parçalara bölüp sırayla AI'a gönderir; her delta'da canlı segmentleri bildirir.
 * Başarısız parça iki kez (2 sn, 5 sn bekleyerek) yeniden denenir; yine olmazsa PipelineError fırlatılır
 * ve `resume` ile aynı parçadan devam edilebilir.
 */
export function processTranscript(
  transcript: string,
  s: Settings,
  onSegments: (segs: Segment[]) => void,
  onProgress: (p: Progress) => void,
  opts: { resume?: ResumeState; deps?: Partial<PipelineDeps> } = {},
): PipelineRun {
  const deps: PipelineDeps = { ...realDeps, ...opts.deps };
  const state: ResumeState = opts.resume ? { ...opts.resume } : { transcript, settings: s, acc: "", next: 0 };
  let current: StreamHandle | null = null;
  let cancelled = false;
  let wake: (() => void) | null = null;

  const promise = (async () => {
    const cfg = state.settings;
    const system = buildStyleSystemPrompt(cfg.systemPrompt, cfg.styleReferences, cfg.styleEnabled);
    const chunks = chunkText(state.transcript, cfg.chunkChars);
    onProgress({ done: state.next, total: chunks.length });
    if (state.acc) onSegments(parseSegments(state.acc));
    try {
      for (let i = state.next; i < chunks.length; i++) {
        const prev = parseSegments(state.acc);
        const prevTitle = prev.length ? prev[prev.length - 1].title : null;
        const base = state.acc ? state.acc + "\n\n" : "";
        let out = "";
        for (let attempt = 0; ; attempt++) {
          if (cancelled) throw new Error(CANCEL_MSG);
          try {
            current = deps.chat({
              baseUrl: cfg.baseUrl,
              model: cfg.model,
              system,
              user: buildChunkMessage(chunks[i], prevTitle, i, chunks.length),
              temperature: cfg.temperature,
              onText: (full) => onSegments(parseSegments(base + full)),
            });
            out = await current.done;
            break;
          } catch (e: any) {
            if (cancelled || e?.message === CANCEL_MSG) throw new Error(CANCEL_MSG);
            if (attempt >= RETRY_DELAYS.length) throw e;
            onSegments(parseSegments(state.acc)); // yarım kalan parça çıktısını at
            await new Promise<void>((res) => {
              wake = res;
              deps.sleep(RETRY_DELAYS[attempt]).then(res);
            });
            wake = null;
          }
        }
        state.acc = base + out.trim();
        state.next = i + 1;
        onSegments(parseSegments(state.acc));
        onProgress({ done: i + 1, total: chunks.length });
      }
      return parseSegments(state.acc);
    } catch (e: any) {
      const isCancel = cancelled || e?.message === CANCEL_MSG;
      throw new PipelineError(isCancel ? CANCEL_MSG : String(e?.message ?? e), isCancel, parseSegments(state.acc), { ...state });
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      current?.cancel();
      wake?.();
    },
  };
}

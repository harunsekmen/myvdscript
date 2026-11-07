import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Project, ProjectMeta, Settings } from "./types";

export interface Transcript {
  lang: string;
  auto: boolean;
  text: string;
  title?: string | null;
}

/** Videodaki bir altyazı seçeneği; auto = otomatik (oto-çeviri dahil). */
export interface SubOption {
  lang: string;
  name: string;
  auto: boolean;
}

export interface SubtitleList {
  title: string;
  options: SubOption[];
}

export interface MediaWord {
  word: string;
  start: number;
  end: number;
}

export interface MediaTranscript {
  language: string;
  duration: number;
  text: string;
  words: MediaWord[];
}

export const api = {
  listProjects: () => invoke<ProjectMeta[]>("list_projects"),
  createProject: (title: string, url: string) => invoke<Project>("create_project", { title, url }),
  loadProject: (id: string) => invoke<Project>("load_project", { id }),
  saveProject: (project: Project) => invoke<number>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  clearAll: () => invoke<void>("clear_all_projects"),
  saveImage: (projectId: string, dataBase64: string, ext: string) =>
    invoke<{ path: string; name: string }>("save_image", { projectId, dataBase64, ext }),
  readImage: (path: string) => invoke<string>("read_image", { path }),
  deleteImage: (path: string) => invoke<void>("delete_image", { path }),
  loadSettings: () => invoke<Partial<Settings>>("load_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  hasApiKey: () => invoke<boolean>("has_api_key"),
  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),
  hasGroqKey: () => invoke<boolean>("has_groq_key"),
  setGroqKey: (key: string) => invoke<void>("set_groq_key", { key }),
  transcribeMedia: (path: string, language: string) =>
    invoke<MediaTranscript>("transcribe_media", { path, language }),
  listSubtitles: (url: string) => invoke<SubtitleList>("list_subtitles", { url }),
  fetchDefaultTranscript: (url: string) => invoke<Transcript>("fetch_default_transcript", { url }),
  fetchTranscript: (url: string, lang: string, auto: boolean) =>
    invoke<Transcript>("fetch_transcript", { url, lang, auto }),
  tts: (text: string) => invoke<{ lang: string; audio: string }>("tts", { text }),
  videoMeta: (url: string) => invoke<{ title: string; description: string; channel: string; chapters: { title: string; start: number }[] }>("video_meta", { url }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  listModels: (baseUrl: string) => invoke<string[]>("list_models", { baseUrl }),
};

export interface StreamHandle {
  done: Promise<string>;
  cancel: () => void;
}

/** Yapay zekâ yanıtını akıtır; onText her delta'da toplanan metni verir. */
export function streamChat(opts: {
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  temperature: number;
  onText?: (full: string) => void;
}): StreamHandle {
  const requestId = crypto.randomUUID();
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  let rejectFn: (e: Error) => void = () => {};

  const done = new Promise<string>(async (resolve, reject) => {
    rejectFn = reject;
    let full = "";
    unlisten = await listen<{ kind: string; text: string }>(`ai://${requestId}`, (e) => {
      const { kind, text } = e.payload;
      if (kind === "delta") {
        full += text;
        opts.onText?.(full);
      } else if (kind === "done") {
        unlisten?.();
        resolve(full);
      } else if (kind === "error") {
        unlisten?.();
        reject(new Error(text));
      }
    });
    if (cancelled) return;
    try {
      await invoke("ai_stream", {
        requestId,
        baseUrl: opts.baseUrl,
        model: opts.model,
        system: opts.system,
        user: opts.user,
        temperature: opts.temperature,
      });
    } catch (err) {
      unlisten?.();
      reject(new Error(String(err)));
    }
  });

  return {
    done,
    cancel: () => {
      cancelled = true;
      unlisten?.();
      invoke("ai_cancel", { requestId }).catch(() => {});
      rejectFn(new CancelledError());
    },
  };
}

export class CancelledError extends Error {
  constructor() {
    super("İptal edildi");
  }
}

/** yt-dlp'nin durum mesajlarını (bağlanma, yeniden deneme) dinler. */
export function onYtdlpStatus(cb: (msg: string) => void) {
  return listen<string>("ytdlp-status", (e) => cb(e.payload));
}

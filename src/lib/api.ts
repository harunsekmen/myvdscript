import type { providerOptions } from "./aiProvider";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CheckItem, Project, ProjectMeta, Settings, SttEngine, VideoStat } from "./types";

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

export interface WhisperStatus {
  engine: boolean;
  /** Ekran kartı (CUDA) motoru indirildi mi? */
  cuda: boolean;
  /** Bulunan NVIDIA ekran kartının adı (yoksa null). */
  gpu: string | null;
  models: { id: string; size: number }[];
  downloading: string | null;
  dir: string;
}

export interface WhisperProgress {
  item: string; // "engine", "cuda" ya da model adı
  received: number;
  total: number;
  done: boolean;
  error: string | null;
}

export interface MediaTranscript {
  language: string;
  duration: number;
  text: string;
  words: MediaWord[];
}

/** Ana sayfadan açık olmayan projeye uygulanabilen alanlar. */
export interface ProjectPatch {
  stage?: string;
  checklist?: CheckItem[];
  note?: string;
  pinned?: boolean;
  archived?: boolean;
  title?: string;
}

export const api = {
  listProjects: () => invoke<ProjectMeta[]>("list_projects"),
  createProject: (title: string, url: string) => invoke<Project>("create_project", { title, url }),
  loadProject: (id: string) => invoke<Project>("load_project", { id }),
  saveProject: (project: Project) => invoke<number>("save_project", { project }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  clearAll: () => invoke<string>("clear_all_projects"),
  listBackups: (projectId: string | null) => invoke<string[]>("list_backups", { projectId }),
  restoreBackup: (projectId: string | null, date: string) => invoke<void>("restore_backup", { projectId, date }),
  exportDiagnostics: (path: string) => invoke<void>("export_diagnostics", { path }),
  automaticUpdateSupported: () => invoke<boolean>("automatic_update_supported"),
  checkManualUpdate: () => invoke<string | null>("check_manual_update"),
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
  transcribeMedia: (path: string, o: { language: string; engine: SttEngine; model: string; gpu: boolean; job?: string }) =>
    invoke<MediaTranscript>("transcribe_media", { path, language: o.language, engine: o.engine, model: o.model, gpu: o.gpu, job: o.job ?? "" }),
  /** Birleşik 16 kHz WAV'ı yazıya çevirir (ham gövde). */
  transcribeAudio: (wav: Uint8Array, o: { language: string; engine: SttEngine; model: string; gpu: boolean; job?: string }) =>
    invoke<MediaTranscript>("transcribe_audio", wav, {
      headers: { "x-language": o.language, "x-engine": o.engine, "x-model": o.model, "x-gpu": o.gpu ? "1" : "0", "x-job": o.job ?? "" },
    }),
  whisperStatus: () => invoke<WhisperStatus>("whisper_status"),
  whisperDownload: (model: string) => invoke<void>("whisper_download", { model }),
  whisperCancelDownload: () => invoke<void>("whisper_cancel_download"),
  whisperDeleteModel: (model: string) => invoke<void>("whisper_delete_model", { model }),
  whisperDownloadCuda: () => invoke<void>("whisper_download_cuda"),
  whisperDeleteCuda: () => invoke<void>("whisper_delete_cuda"),
  testFirefoxCookies: (profile: string) => invoke<number>("test_firefox_cookies", { profile }),
  openFirefoxProfile: () => invoke<string>("open_firefox_profile"),
  listSubtitles: (url: string) => invoke<SubtitleList>("list_subtitles", { url }),
  fetchDefaultTranscript: (url: string) => invoke<Transcript>("fetch_default_transcript", { url }),
  fetchTranscript: (url: string, lang: string, auto: boolean) =>
    invoke<Transcript>("fetch_transcript", { url, lang, auto }),
  tts: (text: string) => invoke<{ lang: string; audio: string }>("tts", { text }),
  videoMeta: (url: string) => invoke<{ title: string; description: string; channel: string; chapters: { title: string; start: number }[] }>("video_meta", { url }),
  videoStreamUrl: (url: string) => invoke<string>("video_stream_url", { url }),
  youtubeEmbedBase: () => invoke<string>("youtube_embed_base"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  saveTextFile: (path: string, contents: string) => invoke<void>("save_text_file", { path, contents }),
  patchProject: (id: string, patch: ProjectPatch) => invoke<number>("patch_project", { id, patch }),
  refreshVideoStats: (urls: string[]) => invoke<VideoStat[]>("refresh_video_stats", { urls }),
  loadVideoStats: () => invoke<Record<string, VideoStat>>("load_video_stats"),
  hasYoutubeKey: () => invoke<boolean>("has_youtube_key"),
  setYoutubeKey: (key: string) => invoke<void>("set_youtube_key", { key }),
  testYoutubeKey: () => invoke<void>("test_youtube_key"),
  codexStatus: (path: string) => invoke<{ version: string; authenticated: boolean; models: string[] }>("codex_status", { path }),
  listModels: (baseUrl: string) => invoke<string[]>("list_models", { baseUrl }),
  saveVoiceTake: (projectId: string, bytes: Uint8Array, ext: string) =>
    invoke<{ file: string }>("save_voice_take", bytes, { headers: { "x-project": projectId, "x-ext": ext } }),
  readVoiceTake: (projectId: string, file: string) => invoke<ArrayBuffer>("read_voice_take", { projectId, file }),
  deleteVoiceTake: (projectId: string, file: string) => invoke<void>("delete_voice_take", { projectId, file }),
  pruneVoiceTakes: (projectId: string, keep: string[]) => invoke<number>("prune_voice_takes", { projectId, keep }),
  exportVoiceTakes: (projectId: string, files: string[], gapMs: number, outPath: string) =>
    invoke<void>("export_voice_takes", { projectId, files, gapMs, outPath }),
  saveBinaryFile: (path: string, bytes: Uint8Array) =>
    invoke<void>("save_binary_file", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
};

export interface StreamHandle {
  done: Promise<string>;
  cancel: () => void;
}

/** Yapay zekâ yanıtını akıtır; onText her delta'da toplanan metni verir. */
export function streamChat(opts: Pick<ReturnType<typeof providerOptions>, "baseUrl" | "model" | "temperature">
  & Partial<Pick<ReturnType<typeof providerOptions>, "codex" | "apiFallback">> & {
  system: string;
  user: string;
  history?: { role: "user" | "assistant"; content: string }[];
  onText?: (full: string) => void;
  onSearch?: (item: string) => void;
}): StreamHandle {
  const requestId = crypto.randomUUID();
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  let rejectDone: (error: Error) => void = () => {};

  const done = new Promise<string>((resolve, reject) => {
    rejectDone = reject;
    let full = "";
    listen<{ kind: string; text: string }>(`ai://${requestId}`, ({ payload: { kind, text } }) => {
      if (cancelled) return;
      if (kind === "delta") {
        full += text;
        opts.onText?.(full);
      } else if (kind === "search") {
        opts.onSearch?.(text);
      } else if (kind === "fallback") {
        window.dispatchEvent(new CustomEvent("sa-ai-fallback", { detail: text }));
      } else if (kind === "done" || kind === "error") {
        unlisten?.();
        if (kind === "done") resolve(full);
        else reject(new Error(text));
      }
    }).then(async (off) => {
      unlisten = off;
      if (cancelled) return off();
      await invoke("ai_stream", {
        requestId, baseUrl: opts.baseUrl, model: opts.model, system: opts.system, user: opts.user,
        temperature: opts.temperature, history: opts.history ?? null, codex: opts.codex ?? null,
        apiFallback: opts.apiFallback ?? false,
      });
      if (cancelled) await invoke("ai_cancel", { requestId });
    }).catch((error) => {
      unlisten?.();
      reject(new Error(String(error)));
    });
  });

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      unlisten?.();
      invoke("ai_cancel", { requestId }).catch(() => {});
      rejectDone(new CancelledError());
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

/** Bir video istatistiği güncellendiğinde (arka planda tek tek) çağrılır. */
export function onVideoStat(cb: (s: VideoStat) => void) {
  return listen<VideoStat>("video-stat", (e) => cb(e.payload));
}

/** Yerel Whisper indirme ilerlemesi. */
export function onWhisperDownload(cb: (p: WhisperProgress) => void) {
  return listen<WhisperProgress>("whisper-download", (e) => cb(e.payload));
}

/** Yerel Whisper çeviri ilerlemesi: yalnızca verilen işin yüzdesi bildirilir. */
export function onSttProgress(job: string, cb: (percent: number) => void) {
  return listen<{ job: string; percent: number }>("stt-progress", (e) => e.payload.job === job && cb(e.payload.percent));
}

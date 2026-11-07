import { api } from "./api";
import { stop as stopSpeech } from "./speech";

/** Oynatıcının anlık durumu; bileşenler useSyncExternalStore ile dinler. */
export interface AudioState {
  projectId: string | null;
  url: string | null;
  status: "idle" | "loading" | "ready" | "error";
  playing: boolean;
  time: number;
  duration: number;
  /** Bu sınıra gelince otomatik durur (tek cümle dinleme). */
  stopAt: number | null;
  error: string | null;
}

const IDLE: AudioState = {
  projectId: null,
  url: null,
  status: "idle",
  playing: false,
  time: 0,
  duration: 0,
  stopAt: null,
  error: null,
};

let st: AudioState = IDLE;
const listeners = new Set<() => void>();
const blobUrls = new Map<string, Promise<string>>();
let audio: HTMLAudioElement | null = null;
let loadToken = 0;

function set(p: Partial<AudioState>) {
  st = { ...st, ...p };
  listeners.forEach((l) => l());
}

export const getAudioState = () => st;
export function subscribeAudio(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Videonun sesini ilk seferde indirir; sonra bellekteki blob adresinden verir. */
function sourceFor(projectId: string, url: string): Promise<string> {
  const key = `${projectId}|${url}`;
  let p = blobUrls.get(key);
  if (!p) {
    p = (async () => {
      const path = await api.ensureAudio(projectId, url);
      const buf = await api.readAudio(path);
      const type = path.endsWith(".mp3") ? "audio/mpeg" : path.endsWith(".webm") ? "audio/webm" : "audio/mp4";
      return URL.createObjectURL(new Blob([buf], { type }));
    })();
    p.catch(() => blobUrls.delete(key));
    blobUrls.set(key, p);
  }
  return p;
}

/** Sesi arka planda önceden indirir; çift tıklayınca aynı indirme beklenir. */
export function prefetchAudio(projectId: string, url: string) {
  sourceFor(projectId, url).catch(() => {});
}

/** Bu proje/URL için oynatıcıyı hazırlar (gerekirse indirir). */
async function ensure(projectId: string, url: string): Promise<HTMLAudioElement> {
  if (audio && st.projectId === projectId && st.url === url && st.status === "ready") return audio;
  const token = ++loadToken;
  audio?.pause();
  set({ projectId, url, status: "loading", playing: false, time: 0, duration: 0, stopAt: null, error: null });
  const src = await sourceFor(projectId, url);
  if (token !== loadToken) throw new Error("iptal edildi");
  const a = new Audio(src);
  a.ontimeupdate = () => {
    if (audio !== a) return;
    if (st.stopAt != null && a.currentTime >= st.stopAt) {
      a.pause();
      set({ playing: false, stopAt: null, time: a.currentTime });
      return;
    }
    set({ time: a.currentTime });
  };
  a.ondurationchange = () => set({ duration: isFinite(a.duration) ? a.duration : 0 });
  a.onplay = () => set({ playing: true });
  a.onpause = () => set({ playing: false });
  a.onended = () => set({ playing: false, stopAt: null });
  await new Promise<void>((resolve, reject) => {
    a.onloadedmetadata = () => resolve();
    a.onerror = () => {
      set({ status: "error", playing: false, error: "Ses çözülemedi" });
      reject(new Error("Ses çözülemedi"));
    };
  });
  a.onerror = () => set({ status: "error", playing: false, error: "Ses çözülemedi" });
  audio = a;
  set({ status: "ready", duration: isFinite(a.duration) ? a.duration : 0 });
  return a;
}

/** Verilen saniyeden çalar; `to` verilirse o saniyede durur. */
export async function playAt(projectId: string, url: string, from: number, to?: number | null): Promise<void> {
  stopSpeech();
  const a = await ensure(projectId, url);
  a.currentTime = Math.max(0, from);
  set({ stopAt: to ?? null, time: a.currentTime });
  await a.play();
}

export function pauseOriginal() {
  audio?.pause();
}

export function seekTo(t: number) {
  if (!audio) return;
  audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
  set({ time: audio.currentTime, stopAt: null });
}

export function stopOriginal() {
  loadToken++;
  audio?.pause();
  audio = null;
  set({ ...IDLE });
}

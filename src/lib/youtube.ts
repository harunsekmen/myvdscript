/** YouTube bağlantısından video kimliğini çıkarır; YouTube değilse null. */
export function videoIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = u.searchParams.get("v");
      if (v) return v;
      return /^\/(?:shorts|embed|live|v)\/([\w-]{6,})/.exec(u.pathname)?.[1] ?? null;
    }
  } catch {
    /* geçersiz URL */
  }
  return null;
}

/** Gömülü oynatıcının anlık durumu; bileşenler useSyncExternalStore ile dinler. */
export interface VideoState {
  videoId: string | null;
  ready: boolean;
  playing: boolean;
  time: number;
  duration: number;
  error: string | null;
  /** Ses seviyesi (0–100) ve sessiz durumu; oturumlar arası saklanır. */
  volume: number;
  muted: boolean;
}

const VOL_KEY = "sa.volume";
const MUTE_KEY = "sa.muted";
const savedVol = () => {
  const v = Number(localStorage.getItem(VOL_KEY));
  return localStorage.getItem(VOL_KEY) != null && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
};

const IDLE: VideoState = { videoId: null, ready: false, playing: false, time: 0, duration: 0, error: null, volume: 100, muted: false };

let st: VideoState = IDLE;
const listeners = new Set<() => void>();
let frame: HTMLIFrameElement | null = null;
let pending: { from: number; to?: number } | null = null;
// Cümle sonunda kendimiz duraklatırız (YouTube'un endSeconds'ı "bitti" ekranını açıyor).
let stopAt: number | null = null;
let listening = false;
// Oynatıcıda video bir kez başlatıldıysa devam ettirmek yeniden yükleme gerektirmez.
let started = false;

function set(p: Partial<VideoState>) {
  st = { ...st, ...p };
  listeners.forEach((l) => l());
}

export const getVideoState = () => st;
export function subscribeVideo(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const send = (msg: object) => frame?.contentWindow?.postMessage(JSON.stringify(msg), "*");
const command = (func: string, args: unknown[] = []) => send({ event: "command", func, args });
const handshake = () => send({ event: "listening", id: 1, channel: "widget" });

function load(from: number, to?: number) {
  if (!st.videoId) return;
  stopAt = to ?? null;
  started = true;
  command("loadVideoById", [{ videoId: st.videoId, startSeconds: Math.max(0, from) }]);
}

function onMessage(e: MessageEvent) {
  if (!frame || e.source !== frame.contentWindow || typeof e.data !== "string") return;
  let d: any;
  try {
    d = JSON.parse(e.data);
  } catch {
    return;
  }
  if (!st.ready) {
    set({ ready: true });
    applyVolume();
    command("addEventListener", ["onApiChange"]);
    disableCaptions();
    if (pending) {
      load(pending.from, pending.to);
      pending = null;
    }
  }
  if (d.event === "onApiChange") {
    disableCaptions();
  } else if (d.event === "onError") {
    set({ error: `Video oynatılamadı (hata ${d.info})` });
  } else if (d.event === "onStateChange" && typeof d.info === "number") {
    set({ playing: d.info === 1 || d.info === 3 });
  } else if ((d.event === "infoDelivery" || d.event === "initialDelivery") && d.info) {
    const p: Partial<VideoState> = {};
    if (typeof d.info.currentTime === "number") p.time = d.info.currentTime;
    if (typeof d.info.duration === "number" && d.info.duration > 0) p.duration = d.info.duration;
    if (typeof d.info.playerState === "number") p.playing = d.info.playerState === 1 || d.info.playerState === 3;
    if (Object.keys(p).length) set(p);
    if (stopAt != null && typeof p.time === "number" && p.time >= stopAt - 0.05 && p.time < stopAt + 5) {
      stopAt = null;
      command("pauseVideo");
    }
  }
}

function disableCaptions() {
  command("setOption", ["captions", "track", {}]);
}

/** Panelin iframe'ini oynatıcı olarak kaydeder; dönen işlev kaydı kaldırır. */
export function attachFrame(f: HTMLIFrameElement, videoId: string): () => void {
  frame = f;
  pending = null;
  stopAt = null;
  started = false;
  set({ ...IDLE, videoId, volume: savedVol(), muted: localStorage.getItem(MUTE_KEY) === "1" });
  if (!listening) {
    window.addEventListener("message", onMessage);
    listening = true;
  }
  // Oynatıcı yüklenene kadar el sıkışma tekrarlanır.
  const timer = setInterval(() => (st.ready ? clearInterval(timer) : handshake()), 600);
  f.addEventListener("load", handshake);
  return () => {
    clearInterval(timer);
    f.removeEventListener("load", handshake);
    if (frame === f) {
      frame = null;
      set({ ...IDLE, volume: st.volume, muted: st.muted });
    }
  };
}

/** Verilen saniyeden oynatır; `to` verilirse o saniyede durur. */
export function playAt(from: number, to?: number | null) {
  if (!frame || !st.videoId) throw new Error("Video paneli yok");
  if (st.ready) load(from, to ?? undefined);
  else pending = { from, to: to ?? undefined };
}

/** Duraklatılan videoyu kaldığı yerden sürdürür (yeniden yüklemeden); hiç başlamadıysa yükler. */
export function resumeVideo() {
  if (!frame || !st.videoId) throw new Error("Video paneli yok");
  if (!st.ready || !started) return playAt(st.time);
  stopAt = null;
  command("playVideo");
}

export function pauseVideo() {
  stopAt = null;
  command("pauseVideo");
}

export function setRate(rate: number) {
  command("setPlaybackRate", [rate]);
}

/** Videoda verilen saniyeye gider (oynatma durumunu değiştirmez). */
export function seekTo(t: number) {
  stopAt = null;
  command("seekTo", [Math.max(0, t), true]);
  set({ time: Math.max(0, t) });
}

function applyVolume() {
  command("setVolume", [st.volume]);
  command(st.muted ? "mute" : "unMute");
}

/** Ses seviyesini (0–100) ayarlar; 0'dan büyükse sessizi kaldırır. */
export function setVolume(v: number) {
  const volume = Math.round(Math.min(100, Math.max(0, v)));
  const muted = volume === 0;
  localStorage.setItem(VOL_KEY, String(volume));
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  set({ volume, muted });
  applyVolume();
}

/** Sesi kapatır/açar; ses 0'dayken açılırsa makul bir seviyeye döner. */
export function toggleMute() {
  if (st.muted || st.volume === 0) {
    const volume = st.volume || 50;
    localStorage.setItem(VOL_KEY, String(volume));
    localStorage.setItem(MUTE_KEY, "0");
    set({ volume, muted: false });
  } else {
    localStorage.setItem(MUTE_KEY, "1");
    set({ muted: true });
  }
  applyVolume();
}

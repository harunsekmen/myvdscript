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
  error: string | null;
}

const IDLE: VideoState = { videoId: null, ready: false, playing: false, time: 0, error: null };

let st: VideoState = IDLE;
const listeners = new Set<() => void>();
let frame: HTMLIFrameElement | null = null;
let pending: { from: number; to?: number } | null = null;
let listening = false;

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
  command("loadVideoById", [{ videoId: st.videoId, startSeconds: Math.max(0, from), ...(to != null ? { endSeconds: to } : {}) }]);
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
    if (pending) {
      load(pending.from, pending.to);
      pending = null;
    }
  }
  if (d.event === "onError") {
    set({ error: `Video oynatılamadı (hata ${d.info})` });
  } else if (d.event === "onStateChange" && typeof d.info === "number") {
    set({ playing: d.info === 1 || d.info === 3 });
  } else if ((d.event === "infoDelivery" || d.event === "initialDelivery") && d.info) {
    const p: Partial<VideoState> = {};
    if (typeof d.info.currentTime === "number") p.time = d.info.currentTime;
    if (typeof d.info.playerState === "number") p.playing = d.info.playerState === 1 || d.info.playerState === 3;
    if (Object.keys(p).length) set(p);
  }
}

/** Panelin iframe'ini oynatıcı olarak kaydeder; dönen işlev kaydı kaldırır. */
export function attachFrame(f: HTMLIFrameElement, videoId: string): () => void {
  frame = f;
  pending = null;
  set({ ...IDLE, videoId });
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
      set({ ...IDLE });
    }
  };
}

/** Verilen saniyeden oynatır; `to` verilirse o saniyede durur. */
export function playAt(from: number, to?: number | null) {
  if (!frame || !st.videoId) throw new Error("Video paneli yok");
  if (st.ready) load(from, to ?? undefined);
  else pending = { from, to: to ?? undefined };
}

export function pauseVideo() {
  command("pauseVideo");
}

export function setRate(rate: number) {
  command("setPlaybackRate", [rate]);
}

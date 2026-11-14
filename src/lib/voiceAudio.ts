import { api } from "./api";
import { encodeWav } from "./voice";

// ---------------------------------------------------------------- Çözme / önbellek

let ctx: AudioContext | null = null;
/** Tek paylaşılan ses bağlamı (çözme ve çalma için). */
export function audioCtx(): AudioContext {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext({ latencyHint: "interactive" });
  return ctx;
}

const buffers = new Map<string, Promise<AudioBuffer>>();
const key = (projectId: string, file: string) => `${projectId}/${file}`;

/** Kaydı diskten okuyup çözer; aynı dosya bir kez çözülür. */
export function loadTake(projectId: string, file: string): Promise<AudioBuffer> {
  const k = key(projectId, file);
  let p = buffers.get(k);
  if (!p) {
    p = api
      .readVoiceTake(projectId, file)
      .then((ab) => audioCtx().decodeAudioData(ab))
      .catch((e) => {
        buffers.delete(k);
        throw e;
      });
    buffers.set(k, p);
  }
  return p;
}

/** Yeni kaydedilen dosyanın çözülmüş halini önbelleğe koyar (yeniden okumamak için). */
export function primeTake(projectId: string, file: string, buf: AudioBuffer) {
  buffers.set(key(projectId, file), Promise.resolve(buf));
}

/** Projenin çözülmüş seslerini bellekten atar (proje kapanırken / dosya silinince). */
export function forgetTakes(projectId: string, file?: string) {
  if (file) buffers.delete(key(projectId, file));
  else for (const k of [...buffers.keys()]) if (k.startsWith(`${projectId}/`)) buffers.delete(k);
}

/** Kanalların ortalaması. */
export function monoOf(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

const peakCache = new WeakMap<AudioBuffer, Float32Array>();
/** Dalga formu için `n` kovada tepe değerleri (0..1, en yükseğe göre ölçekli). */
export function peaksOf(buf: AudioBuffer, n = 160): Float32Array {
  const hit = peakCache.get(buf);
  if (hit && hit.length === n) return hit;
  const d = monoOf(buf);
  const out = new Float32Array(n);
  const step = Math.max(1, Math.floor(d.length / n));
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(d.length, (i + 1) * step);
    for (let j = i * step; j < end; j += 4) m = Math.max(m, Math.abs(d[j]));
    out[i] = m;
    max = Math.max(max, m);
  }
  if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
  peakCache.set(buf, out);
  return out;
}

/** Parçaları aralarında boşlukla tek WAV'a birleştirir (ffmpeg yoksa yedek yol). */
export async function mergeToWav(projectId: string, files: string[], gapMs: number): Promise<Uint8Array> {
  const bufs = await Promise.all(files.map((f) => loadTake(projectId, f)));
  const rate = bufs[0]?.sampleRate ?? 48000;
  const gap = Math.round((Math.max(0, gapMs) / 1000) * rate);
  const total = bufs.reduce((n, b) => n + b.length, 0) + gap * Math.max(0, bufs.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  bufs.forEach((b, i) => {
    out.set(monoOf(b), o);
    o += b.length + (i < bufs.length - 1 ? gap : 0);
  });
  return encodeWav(out, rate);
}

// ---------------------------------------------------------------- Oynatıcı

export interface PlayItem {
  file: string;
  start: number; // çizelgedeki başlangıç (sn)
}

/**
 * Parçaları Web Audio ile kesintisiz sıralı çalar. Konum her zaman ortak zaman çizelgesine göredir; böylece tek parça
 * çalarken de aynı ilerleme çubuğu ve kelime vurgusu kullanılır.
 */
export class VoicePlayer {
  private sources: AudioBufferSourceNode[] = [];
  private t0 = 0; // ctx zamanı
  private from = 0; // çizelgedeki başlangıç
  private until = 0;
  private token = 0;
  playing = false;

  /** `from` anından başlayıp `until` anında (yoksa son parçanın sonunda) durur. */
  async play(projectId: string, items: PlayItem[], from: number, onEnd: () => void, until?: number): Promise<void> {
    this.stop();
    const my = ++this.token;
    const c = audioCtx();
    if (c.state === "suspended") await c.resume();
    const loaded = await Promise.all(items.map(async (it) => ({ ...it, buf: await loadTake(projectId, it.file) })));
    if (my !== this.token) return;
    const end = until ?? Math.max(0, ...loaded.map((x) => x.start + x.buf.duration));
    const now = c.currentTime + 0.05;
    this.t0 = now;
    this.from = from;
    this.until = end;
    let last: AudioBufferSourceNode | null = null;
    let lastEnd = -1;
    for (const it of loaded) {
      const itEnd = Math.min(it.start + it.buf.duration, end);
      if (itEnd <= from) continue;
      const offset = Math.max(0, from - it.start);
      const when = now + Math.max(0, it.start - from);
      const src = c.createBufferSource();
      src.buffer = it.buf;
      src.connect(c.destination);
      src.start(when, offset, itEnd - it.start - offset);
      this.sources.push(src);
      if (itEnd > lastEnd) {
        last = src;
        lastEnd = itEnd;
      }
    }
    if (!last) {
      onEnd();
      return;
    }
    this.playing = true;
    last.onended = () => {
      if (my !== this.token) return;
      this.playing = false;
      this.sources = [];
      onEnd();
    };
  }

  /** Çizelgedeki anlık konum (çalmıyorsa null). */
  position(): number | null {
    if (!this.playing || !ctx) return null;
    return Math.min(this.until, this.from + Math.max(0, ctx.currentTime - this.t0));
  }

  stop() {
    this.token++;
    this.playing = false;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* başlamamış olabilir */
      }
      s.disconnect();
    }
    this.sources = [];
  }
}

// ---------------------------------------------------------------- Kayıt

export interface RecorderOptions {
  deviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface RecordedTake {
  bytes: Uint8Array;
  ext: string;
  buffer: AudioBuffer;
}

const MIME_CANDIDATES: [string, string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/webm", "webm"],
];

/** Mikrofonu açar; izin yoksa ya da cihaz bulunamazsa anlaşılır bir hata fırlatır. */
export async function openMic(o: RecorderOptions): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    noiseSuppression: o.noiseSuppression,
    echoCancellation: o.echoCancellation,
    autoGainControl: o.autoGainControl,
  };
  if (o.deviceId) audio.deviceId = { exact: o.deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "OverconstrainedError" && o.deviceId) {
      // Seçili mikrofon takılı değil: varsayılana düş.
      return openMic({ ...o, deviceId: "" });
    }
    if (name === "NotAllowedError") throw new Error("Mikrofon izni verilmedi (Windows Ayarlar › Gizlilik › Mikrofon)");
    if (name === "NotFoundError") throw new Error("Mikrofon bulunamadı");
    if (name === "NotReadableError") throw new Error("Mikrofon başka bir uygulama tarafından kullanılıyor");
    throw new Error(`Mikrofon açılamadı: ${e}`);
  }
}

/** Ses seviyesi ölçer (0..1, yaklaşık tepe). */
export function levelMeter(stream: MediaStream): { level: () => number; close: () => void } {
  const c = audioCtx();
  const src = c.createMediaStreamSource(stream);
  const an = c.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const data = new Float32Array(an.fftSize);
  return {
    level: () => {
      an.getFloatTimeDomainData(data);
      let m = 0;
      for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i]));
      return Math.min(1, m);
    },
    close: () => {
      src.disconnect();
      an.disconnect();
    },
  };
}

/** Süren bir kayıt: duraklatılabilir, bitirilebilir ya da iptal edilebilir. */
export class Recording {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private meter: ReturnType<typeof levelMeter>;
  private startedAt = performance.now();
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private ext: string;
  private stopped: Promise<void>;
  peak = 0; // kayıt boyunca en yüksek seviye (sessiz kayıt uyarısı için)

  private constructor(private stream: MediaStream) {
    const pick = MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m));
    this.ext = pick?.[1] ?? "webm";
    this.rec = new MediaRecorder(stream, pick ? { mimeType: pick[0], audioBitsPerSecond: 128_000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.stopped = new Promise((res) => (this.rec.onstop = () => res()));
    this.meter = levelMeter(stream);
    this.rec.start(1000);
  }

  static async start(o: RecorderOptions): Promise<Recording> {
    const stream = await openMic(o);
    const c = audioCtx();
    if (c.state === "suspended") await c.resume();
    return new Recording(stream);
  }

  get paused() {
    return this.pausedAt !== null;
  }

  level(): number {
    if (this.paused) return 0;
    const l = this.meter.level();
    this.peak = Math.max(this.peak, l);
    return l;
  }

  elapsed(): number {
    const now = this.pausedAt ?? performance.now();
    return (now - this.startedAt - this.pausedTotal) / 1000;
  }

  pause() {
    if (this.paused || this.rec.state !== "recording") return;
    this.rec.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    if (!this.paused) return;
    this.rec.resume();
    this.pausedTotal += performance.now() - (this.pausedAt ?? performance.now());
    this.pausedAt = null;
  }

  private release() {
    this.meter.close();
    this.stream.getTracks().forEach((t) => t.stop());
  }

  /** Kaydı bitirir; baytları ve çözülmüş sesi döndürür. */
  async finish(): Promise<RecordedTake> {
    if (this.rec.state !== "inactive") this.rec.stop();
    await this.stopped;
    this.release();
    const blob = new Blob(this.chunks, { type: this.rec.mimeType || "audio/webm" });
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab.slice(0));
    const buffer = await audioCtx().decodeAudioData(ab);
    return { bytes, ext: this.ext, buffer };
  }

  cancel() {
    this.rec.ondataavailable = null;
    if (this.rec.state !== "inactive") this.rec.stop();
    this.chunks = [];
    this.release();
  }
}

/** Kayıt cihazları (etiketler ancak izin verildikten sonra dolar). */
export async function listMics(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }));
}

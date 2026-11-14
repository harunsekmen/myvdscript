import { buildTimed, newId } from "./timed";
import type { TimedDoc, TimedItem, VoiceTake } from "./types";

/** Soldaki bölümlerin mikrofon düğmesi bu olayı yayar (detail: VoiceTake["link"]); o bölüm için kayıt başlar. */
export const VOICE_RECORD_EVENT = "voice:record";

/** Tüm kayıtlar art arda çalındığında bir parçanın zaman çizelgesindeki yeri. */
export interface TimelineItem {
  take: VoiceTake;
  index: number;
  start: number; // sn
  end: number;
}

/** Parçaları sırayla, aralarına `gapMs` boşluk koyarak tek zaman çizelgesine dizer. */
export function buildTimeline(takes: VoiceTake[], gapMs: number): { items: TimelineItem[]; total: number } {
  const gap = Math.max(0, gapMs) / 1000;
  const items: TimelineItem[] = [];
  let t = 0;
  takes.forEach((take, index) => {
    if (index > 0) t += gap;
    const d = Math.max(0, take.duration || 0);
    items.push({ take, index, start: t, end: t + d });
    t += d;
  });
  return { items, total: t };
}

/** Verilen andaki parça; boşluğa düşerse sonraki parça (offset 0). Çizelge dışındaysa null. */
export function locate(items: TimelineItem[], t: number): { index: number; offset: number } | null {
  for (const it of items) {
    if (t < it.end) return { index: it.index, offset: Math.max(0, t - it.start) };
  }
  return null;
}

/** Parçanın listede görünen adı: verilen ad, yoksa bağlı bölüm başlığı, yoksa "Parça N". */
export function takeTitle(take: VoiceTake, index: number): string {
  return take.label?.trim() || `Parça ${index + 1}`;
}

/** Süre biçimi: 1:05 ya da 1:02:03. */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Yazıya çevrilmiş parçaların düz metni (her parça bir paragraf). */
export function takesText(takes: VoiceTake[]): string[] {
  return takes.map((t) => t.stt?.text.trim() ?? "").filter(Boolean);
}

/**
 * Parçaları tek bir zamanlı metne çevirir: kelime zamanları birleşik kayda göre kaydırılır, parçalar arasında satır
 * sonu olur. Bağlı kaynak bölüm değiştiğinde (ve ilk parçada) bölüm başlığı not olarak eklenir.
 */
export function takesToTimed(takes: VoiceTake[], gapMs: number, source: string): TimedDoc {
  const { items } = buildTimeline(takes, gapMs);
  const out: TimedItem[] = [];
  let lang = "";
  let lastSeg: string | null = null;
  for (const it of items) {
    const stt = it.take.stt;
    if (!stt?.words.length) continue;
    lang ||= stt.lang;
    if (out.length) out.push({ k: "br" });
    const seg = it.take.link?.segmentId ?? null;
    if (seg && seg !== lastSeg) out.push({ k: "note", id: newId(), text: `Bölüm: ${it.take.link!.title}` });
    lastSeg = seg ?? lastSeg;
    const words = stt.words.map((w) => ({ word: w.w, start: it.start + w.s, end: it.start + w.e }));
    out.push(...buildTimed(words, source, stt.lang).items);
  }
  return { source, lang: lang || "?", items: out };
}

/** Kanalları teke indirip 16 bit PCM WAV üretir. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** Parça listesinde öğeyi `from` konumundan `to` konumuna taşır (`to`, taşımadan önceki listeye göre ekleme yeri). */
export function moveTake<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from + 1 === to) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, x);
  return next;
}

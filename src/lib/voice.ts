import { buildTimed, newId } from "./timed";
import type { TimedDoc, TimedItem, VoiceTake, VoiceWord } from "./types";

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
  return takeParagraphs(takes).map(({ text, note }) => (note ? `[Not: ${text}]` : text));
}

export function takeParagraphs(takes: VoiceTake[]): { text: string; note: boolean }[] {
  return takes
    .map((take, index) => ({
      note: !!take.note,
      text: take.stt?.text.trim() || (take.note ? takeTitle(take, index) : ""),
    }))
    .filter(({ text }) => !!text);
}

/**
 * Parçaları tek bir zamanlı metne çevirir: kelime zamanları birleşik kayda göre kaydırılır, parçalar arasında satır
 * sonu olur. Bağlı kaynak bölüm değiştiğinde (ve ilk parçada) bölüm başlığı not olarak eklenir.
 */
export function takesToTimed(takes: VoiceTake[], gapMs: number, source: string): TimedDoc {
  const { items } = buildTimeline(takes.filter((take) => !take.note), gapMs);
  const out: TimedItem[] = [];
  let lang = "";
  let lastSeg: string | null = null;
  let audioIndex = 0;
  for (const [index, take] of takes.entries()) {
    const it = take.note ? undefined : items[audioIndex++];
    const stt = take.stt;
    if (!take.note && !stt?.words.length) continue;
    lang ||= stt?.lang ?? "";
    if (out.length) out.push({ k: "br" });
    const seg = take.link?.segmentId ?? null;
    if (seg && seg !== lastSeg) out.push({ k: "note", id: newId(), text: `Bölüm: ${take.link!.title}` });
    lastSeg = seg ?? lastSeg;
    if (!it) {
      out.push({ k: "note", id: newId(), text: stt?.text.trim() || takeTitle(take, index) });
    } else if (stt) {
      const words = stt.words.map((w) => ({ word: w.w, start: it.start + w.s, end: it.start + w.e }));
      out.push(...buildTimed(words, source, stt.lang).items);
    }
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

/** Ardışık, aynı bölüme bağlı parçaları bir paragrafta toplar (ses akışını metin gibi göstermek için). */
export function groupTakes<T extends { take: VoiceTake }>(items: T[]): { segmentId: string | null; title: string | null; items: T[] }[] {
  const out: { segmentId: string | null; title: string | null; items: T[] }[] = [];
  for (const it of items) {
    const seg = it.take.link?.segmentId ?? null;
    const last = out[out.length - 1];
    if (last && last.segmentId === seg) last.items.push(it);
    else out.push({ segmentId: seg, title: it.take.link?.title ?? null, items: [it] });
  }
  return out;
}

// ---------------------------------------------------------------- Toplu yazıya çevirme

/**
 * Yazıya çevrilecek parçaları istek gruplarına ayırır: parçalar tek seste art arda (aralarında `gapSec` sessizlik)
 * gönderilir; bir grup en fazla `maxSec` uzunluğundadır (tek başına daha uzun parça kendi grubunu oluşturur).
 */
export function packBatches<T extends { duration: number }>(items: T[], maxSec: number, gapSec: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let len = 0;
  for (const it of items) {
    const add = (cur.length ? gapSec : 0) + Math.max(0, it.duration);
    if (cur.length && len + add > maxSec) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    len += (cur.length ? gapSec : 0) + Math.max(0, it.duration);
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Birleşik sesten gelen kelimeleri parçalara dağıtır. Kelime, orta noktasının düştüğü parçaya gider (aradaki
 * sessizliğin ilk yarısı önceki, ikinci yarısı sonraki parçaya sayılır); zamanlar parçanın başına göredir.
 */
export function splitWords(
  words: { word: string; start: number; end: number }[],
  spans: { start: number; duration: number }[],
): VoiceWord[][] {
  const out: VoiceWord[][] = spans.map(() => []);
  if (!spans.length) return out;
  for (const w of words) {
    const text = w.word.trim();
    if (!text) continue;
    const mid = (w.start + w.end) / 2;
    let i = 0;
    while (i < spans.length - 1) {
      const end = spans[i].start + spans[i].duration;
      const next = spans[i + 1].start;
      if (mid < (end + next) / 2) break;
      i++;
    }
    const sp = spans[i];
    const s = Math.min(sp.duration, Math.max(0, w.start - sp.start));
    const e = Math.min(sp.duration, Math.max(s, w.end - sp.start));
    out[i].push({ w: text, s, e });
  }
  return out;
}

const normWord = (s: string) => s.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Kelime listesinde noktalama yoksa, tam metindeki karşılığıyla değiştirir ("konuşalım" → "konuşalım.").
 * Eşleşme bulunamayan kelime olduğu gibi kalır.
 */
export function alignPunctuation(text: string, words: string[]): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  let ti = 0;
  return words.map((w) => {
    const n = normWord(w);
    if (!n) return w;
    for (let k = ti; k < Math.min(tokens.length, ti + 6); k++) {
      if (normWord(tokens[k]) === n) {
        ti = k + 1;
        return tokens[k];
      }
    }
    return w;
  });
}

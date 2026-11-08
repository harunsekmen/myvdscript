import type { TimedItem } from "./types";

export interface Cue {
  start: number;
  end: number;
  /** Satırlar "\n" ile ayrılmış (en fazla 2 satır) */
  text: string;
}

export interface CueOptions {
  /** Satır başına en çok karakter */
  maxChars: number;
  /** Bir altyazının en uzun süresi (sn) */
  maxDur: number;
  /** En kısa süre (sn); sonraki altyazıyı ezmeden uzatılır */
  minDur: number;
  /** Bu kadar saniyelik sessizlikte altyazı bölünür */
  gap: number;
}

export const DEFAULT_CUE_OPTIONS: CueOptions = { maxChars: 42, maxDur: 6.5, minDur: 0.8, gap: 1 };

type W = { w: string; s: number; e: number };

/** Metni en fazla iki satıra, mümkün olduğunca dengeli böler. */
export function wrapCue(words: string[], maxChars: number): string {
  const one = words.join(" ");
  if (one.length <= maxChars || words.length < 2) return one;
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length;
    const b = words.slice(i).join(" ").length;
    const diff = Math.abs(a - b) + (a > maxChars || b > maxChars ? 1000 : 0);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return words.slice(0, best).join(" ") + "\n" + words.slice(best).join(" ");
}

/** Kelimelerden altyazı blokları üretir. Satır sonları (br) kesin sınırdır; notlar ve resimler yok sayılır. */
export function buildCues(items: TimedItem[], opts: Partial<CueOptions> = {}): Cue[] {
  const o = { ...DEFAULT_CUE_OPTIONS, ...opts };
  const segments: W[][] = [[]];
  for (const it of items) {
    if (it.k === "br") segments.push([]);
    else if (it.k === "w") {
      const t = it.w.trim();
      if (t) segments[segments.length - 1].push({ w: t, s: it.s, e: Math.max(it.e, it.s) });
    }
  }
  const cues: Cue[] = [];
  const maxTotal = o.maxChars * 2;
  for (const seg of segments) {
    let cur: W[] = [];
    const flush = () => {
      if (!cur.length) return;
      cues.push({ start: cur[0].s, end: cur[cur.length - 1].e, text: wrapCue(cur.map((x) => x.w), o.maxChars) });
      cur = [];
    };
    for (const w of seg) {
      if (cur.length) {
        const len = cur.map((x) => x.w).join(" ").length + 1 + w.w.length;
        const last = cur[cur.length - 1];
        const tooLong = len > maxTotal || w.e - cur[0].s > o.maxDur;
        const pause = w.s - last.e > o.gap;
        const sentenceEnd = /[.!?…]$/.test(last.w) && len - w.w.length > o.maxChars * 0.5;
        if (tooLong || pause || sentenceEnd) flush();
      }
      cur.push(w);
    }
    flush();
  }
  // Çakışmayı önle, en kısa süreyi sağla
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    if (c.end - c.start < o.minDur) c.end = c.start + o.minDur;
    if (next) {
      if (next.start < c.start) next.start = c.start;
      if (c.end > next.start) c.end = next.start;
      if (c.end <= c.start) c.end = c.start + 0.001;
      if (next.start < c.end) next.start = c.end;
    }
  }
  return cues;
}

function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
}

export const srtTime = (sec: number) => stamp(sec, ",");
export const vttTime = (sec: number) => stamp(sec, ".");

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

export function toVtt(cues: Cue[]): string {
  const body = cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

/** Kaynak dosya adından uzantısız temel ad. */
export function baseName(source: string): string {
  const n = source.split(/[\\/]/).pop() ?? source;
  return n.replace(/\.[^.]+$/, "") || "altyazi";
}

import { fmtTime } from "./timed";
import type { TimedDoc, TimedItem } from "./types";

export type CutType = "silence" | "filler" | "maybe" | "retake" | "repeat";

export interface Cut {
  /** Kararlı kimlik: kelime kimliklerinden türer */
  id: string;
  type: CutType;
  start: number;
  end: number;
  /** Etkilenen kelimeler (sessizlikte boş) */
  wordIds: string[];
  /** Zamanlı metinde gidilecek kelime */
  anchorId: string;
  text: string;
  /** Kullanıcı karar vermediyse varsayılan seçili mi */
  defaultOn: boolean;
}

export interface Range {
  start: number;
  end: number;
}

export type CutPrefs = NonNullable<TimedDoc["cuts"]>;

export const TYPE_LABEL: Record<CutType, string> = {
  silence: "Sessizlik",
  filler: "Dolgu",
  maybe: "Olası dolgu",
  retake: "Tekrar çekim",
  repeat: "Tekrar",
};

export const DEFAULT_SILENCE_SEC = 1.5;
export const SILENCE_PAD = 0.15;

export type CutWord = { id: string; w: string; n: string; s: number; e: number };

/** Küçük harf (tr), noktalama yok, ardışık tekrar eden harfler teke iner: "Iıııı," → "ı". */
export function normWord(w: string): string {
  return w
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(.)\1+/gu, "$1");
}

const FILLERS = new Set(["ı", "e", "ö", "hm", "m", "hım", "ım", "hı", "eh", "um", "uh", "uhm", "erm", "er", "mhm"]);
const MAYBE_FILLERS = new Set(["şey", "yani", "işte"]);

export const isFiller = (w: string) => FILLERS.has(normWord(w));
export const isMaybeFiller = (w: string) => MAYBE_FILLERS.has(normWord(w));

export function cutWords(items: TimedItem[]): CutWord[] {
  const out: CutWord[] = [];
  for (const it of items) if (it.k === "w") out.push({ id: it.id, w: it.w, n: normWord(it.w), s: it.s, e: Math.max(it.e, it.s) });
  return out;
}

const excerpt = (ws: CutWord[], max = 70) => {
  const t = ws.map((x) => x.w).join(" ");
  if (t.length <= max) return t;
  const half = Math.floor((max - 1) / 2);
  return t.slice(0, half) + "…" + t.slice(-half);
};

/** Sessizlikler: ardışık kelimeler arasındaki `threshold` sn'den uzun boşluklar (kenarlarda pay bırakılır). */
export function detectSilences(words: CutWord[], threshold: number, pad = SILENCE_PAD): Cut[] {
  const out: Cut[] = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1];
    const b = words[i];
    const gap = b.s - a.e;
    if (gap <= threshold) continue;
    const start = a.e + pad;
    const end = b.s - pad;
    if (end - start < 0.05) continue;
    out.push({ id: `sil:${a.id}`, type: "silence", start, end, wordIds: [], anchorId: a.id, text: `${gap.toFixed(1)} sn boşluk`, defaultOn: true });
  }
  return out;
}

/** Dolgu sesleri ve olası dolgular. */
export function detectFillers(words: CutWord[]): Cut[] {
  const out: Cut[] = [];
  for (const w of words) {
    if (FILLERS.has(w.n)) out.push({ id: `fil:${w.id}`, type: "filler", start: w.s, end: w.e, wordIds: [w.id], anchorId: w.id, text: w.w, defaultOn: true });
    else if (MAYBE_FILLERS.has(w.n)) out.push({ id: `may:${w.id}`, type: "maybe", start: w.s, end: w.e, wordIds: [w.id], anchorId: w.id, text: w.w, defaultOn: false });
  }
  return out;
}

/** Hemen art arda tekrarlanan aynı kelime ("bu bu"): öndeki silinir. */
export function detectRepeats(words: CutWord[]): Cut[] {
  const out: Cut[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (!a.n || a.n !== b.n || FILLERS.has(a.n)) continue;
    out.push({ id: `rep:${a.id}`, type: "repeat", start: a.s, end: b.s, wordIds: [a.id], anchorId: a.id, text: `${a.w} ${b.w}`, defaultOn: true });
  }
  return out;
}

const MAX_SPAN_WORDS = 40;
const MAX_SPAN_SEC = 25;

const nChars = (ws: CutWord[]) => ws.reduce((a, w) => a + w.n.length, 0);

/**
 * Yeniden çekimler: bir cümle/öbek başlangıcı kısa süre sonra aynen (ya da çok benzer) tekrarlanırsa
 * ilk (yarım bırakılan) deneme silinir. Birden fazla deneme zincirleme yakalanır.
 */
export function detectRetakes(words: CutWord[]): Cut[] {
  const out: Cut[] = [];
  const n = words.length;
  let i = 0;
  while (i < n) {
    let found = -1;
    for (let j = i + 2; j < n && j - i <= MAX_SPAN_WORDS; j++) {
      if (words[j].s - words[i].s > MAX_SPAN_SEC) break;
      if (!words[i].n || words[i].n !== words[j].n) continue;
      let pre = 0;
      while (j + pre < n && i + pre < j && words[i + pre].n === words[j + pre].n) pre++;
      const chars = nChars(words.slice(i, i + pre));
      // Üç+ kelimelik aynı başlangıç
      if (pre >= 3 && chars >= 8) {
        found = j;
        break;
      }
      // İki kelimelik başlangıç + ilk ~8 kelimede yüksek benzerlik
      if (pre >= 2 && chars >= 6) {
        const L = Math.min(8, j - i, n - j);
        let same = 0;
        for (let k = 0; k < L; k++) if (words[i + k].n === words[j + k].n) same++;
        if (L >= 5 && same / L >= 0.6) {
          found = j;
          break;
        }
      }
    }
    if (found < 0) {
      i++;
      continue;
    }
    const take = words.slice(i, found);
    const pause = words[found].s - words[found - 1].e;
    out.push({
      id: `ret:${words[i].id}`,
      type: "retake",
      start: words[i].s,
      end: words[found].s,
      wordIds: take.map((w) => w.id),
      anchorId: words[i].id,
      text: excerpt(take),
      defaultOn: pause >= 0.3,
    });
    i = found;
  }
  return out;
}

/** Tüm önerileri zamana göre sıralı üretir. */
export function buildCuts(items: TimedItem[], silenceSec = DEFAULT_SILENCE_SEC): Cut[] {
  const words = cutWords(items);
  const all = [...detectSilences(words, silenceSec), ...detectFillers(words), ...detectRepeats(words), ...detectRetakes(words)];
  return all.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function isCutOn(cut: Cut, prefs: CutPrefs | undefined): boolean {
  if (prefs?.on?.includes(cut.id)) return true;
  if (prefs?.off?.includes(cut.id)) return false;
  return cut.defaultOn;
}

/** Kullanıcının seçimini kaydeder (varsayılanla aynıysa kayıt tutmaz). */
export function setCutOn(prefs: CutPrefs | undefined, cut: Cut, on: boolean): CutPrefs {
  const off = (prefs?.off ?? []).filter((x) => x !== cut.id);
  const onL = (prefs?.on ?? []).filter((x) => x !== cut.id);
  if (on !== cut.defaultOn) (on ? onL : off).push(cut.id);
  return { ...prefs, off, on: onL };
}

/** Örtüşen/bitişik aralıkları birleştirir. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** Kesilen aralıkların tersi: korunan aralıklar [0, total]. Çok kısa parçalar atılır. */
export function keptRanges(cuts: Range[], total: number, minLen = 0.02): Range[] {
  const merged = mergeRanges(cuts);
  const out: Range[] = [];
  let pos = 0;
  for (const c of merged) {
    const s = Math.max(0, c.start);
    if (s - pos >= minLen) out.push({ start: pos, end: s });
    pos = Math.max(pos, c.end);
  }
  if (total - pos >= minLen) out.push({ start: pos, end: total });
  return out;
}

/** Kaynak süresi (yaklaşık): son kelimenin bitişi + pay. */
export function sourceDuration(items: TimedItem[], pad = 0.3): number {
  let end = 0;
  for (const it of items) if (it.k === "w") end = Math.max(end, it.e);
  return end + pad;
}

export const totalLen = (r: Range[]) => r.reduce((a, x) => a + (x.end - x.start), 0);

/** Kabul edilmiş kesimlerin birleşik aralıkları. */
export function acceptedRanges(cuts: Cut[], prefs: CutPrefs | undefined): Range[] {
  return mergeRanges(cuts.filter((c) => isCutOn(c, prefs)).map((c) => ({ start: c.start, end: c.end })));
}

/** Birleşik kesim aralıkları içinde kalan kelimelerin kimlikleri (orta noktaya göre). */
export function cutWordIds(items: TimedItem[], ranges: Range[]): Set<string> {
  const set = new Set<string>();
  if (!ranges.length) return set;
  for (const it of items) {
    if (it.k !== "w") continue;
    const mid = (it.s + it.e) / 2;
    if (ranges.some((r) => mid >= r.start && mid <= r.end)) set.add(it.id);
  }
  return set;
}

// ---- Dışa aktarma ----

export const FPS_OPTIONS = [24, 25, 30, 60] as const;

/** hh:mm:ss:ff (drop-frame olmayan). */
export function timecode(sec: number, fps: number): string {
  const total = Math.max(0, Math.round(sec * fps));
  const ff = total % fps;
  const s = Math.floor(total / fps);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(ff)}`;
}

/** Kesim listesi düz metin. */
export function cutsToText(cuts: Cut[]): string {
  return (
    cuts
      .map((c) => `${fmtTime(c.start)} - ${fmtTime(c.end)}  (${(c.end - c.start).toFixed(2)} sn)  [${TYPE_LABEL[c.type]}]  ${c.text}`)
      .join("\n") + (cuts.length ? "\n" : "")
  );
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** CMX3600 EDL: korunan aralıklar peş peşe dizilir (video + ses). Kayıt zamanı 01:00:00:00'da başlar. */
export function toEdl(kept: Range[], opts: { title: string; clip: string; fps: number; recordStart?: number }): string {
  const { fps } = opts;
  const lines = [`TITLE: ${oneLine(opts.title)}`, "FCM: NON-DROP FRAME", ""];
  let rec = Math.round((opts.recordStart ?? 3600) * fps);
  const tc = (frames: number) => timecode(frames / fps, fps);
  kept.forEach((r, i) => {
    const a = Math.round(r.start * fps);
    const b = Math.max(a + 1, Math.round(r.end * fps));
    const len = b - a;
    const no = String(i + 1).padStart(3, "0");
    for (const track of ["V", "A"]) {
      lines.push(`${no}  AX       ${track.padEnd(5)} C        ${tc(a)} ${tc(b)} ${tc(rec)} ${tc(rec + len)}`);
    }
    lines.push(`* FROM CLIP NAME: ${oneLine(opts.clip)}`, "");
    rec += len;
  });
  return lines.join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** FCPXML 1.9 (yaklaşık): korunan aralıklar tek bir asset-clip dizisi olarak. Kaynak süresi tahmindir. */
export function toFcpxml(kept: Range[], opts: { name: string; clip: string; fps: number; duration: number }): string {
  const { fps } = opts;
  const t = (frames: number) => `${frames}/${fps}s`;
  const fr = (sec: number) => Math.round(sec * fps);
  let offset = 0;
  const clips = kept
    .map((r) => {
      const a = fr(r.start);
      const len = Math.max(1, fr(r.end) - a);
      const line = `            <asset-clip ref="r2" offset="${t(offset)}" name="${xml(opts.name)}" start="${t(a)}" duration="${t(len)}" format="r1" tcFormat="NDF"/>`;
      offset += len;
      return line;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat1080p${fps}" frameDuration="1/${fps}s" width="1920" height="1080"/>
    <asset id="r2" name="${xml(opts.name)}" start="0s" duration="${t(fr(opts.duration))}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="${xml("file:///" + encodeURI(opts.clip))}"/>
    </asset>
  </resources>
  <library>
    <event name="${xml(opts.name)}">
      <project name="${xml(opts.name)} (kesim)">
        <sequence format="r1" duration="${t(offset)}" tcStart="0s" tcFormat="NDF">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

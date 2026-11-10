import type { DisfluencyKind, ImageMeta, TimedDoc, TimedItem } from "./types";
import type { CopyMode } from "./copyExport";

export interface Line {
  /** Satırdaki öğeler ve genel (items) dizinleri */
  items: { item: TimedItem; idx: number }[];
  /** Satır sonu konumu: buraya eklenen öğe satırın sonuna düşer */
  endPos: number;
}

/** Saniyeyi dk:sn.salise biçimine çevirir (ör. 00:12.34). */
export function fmtTime(sec: number, digits = 2): string {
  const total = Math.max(0, Math.round(sec * 10 ** digits));
  const unit = 10 ** digits;
  const frac = String(total % unit).padStart(digits, "0");
  const s = Math.floor(total / unit);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const head = h > 0 ? `${h}:` : "";
  return digits > 0 ? `${head}${mm}:${ss}.${frac}` : `${head}${mm}:${ss}`;
}

/** Whisper kelime listesinden, duraklama ve cümle sonlarına göre satırlara bölünmüş belge üretir. */
export function buildTimed(words: { word: string; start: number; end: number }[], source: string, lang: string): TimedDoc {
  const items: TimedItem[] = [];
  let prev: { w: string; e: number } | null = null;
  let count = 0;
  for (const w of words) {
    const text = w.word.trim();
    if (!text) continue;
    if (prev) {
      const pause = w.start - prev.e > 0.8;
      const sentenceEnd = count >= 6 && /[.!?…]$/.test(prev.w);
      if (pause || count >= 12 || sentenceEnd) {
        items.push({ k: "br" });
        count = 0;
      }
    }
    items.push({ k: "w", id: newId(), w: text, s: w.start, e: w.end });
    prev = { w: text, e: w.end };
    count++;
  }
  return { source, lang, items };
}

/** Öğeleri satırlara ayırır. Her satırın endPos'u, satır sonuna ekleme için konumdur. */
export function splitLines(items: TimedItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line["items"] = [];
  items.forEach((item, idx) => {
    if (item.k === "br") {
      lines.push({ items: cur, endPos: idx });
      cur = [];
    } else cur.push({ item, idx });
  });
  if (cur.length || lines.length === 0) lines.push({ items: cur, endPos: items.length });
  return lines;
}

/** Bir notun/resmin zamanı: sonrasındaki ilk kelime; yoksa öncekinin bitişi. */
export function anchorTime(items: TimedItem[], i: number): number {
  for (let j = i + 1; j < items.length; j++) {
    const it = items[j];
    if (it.k === "w") return it.s;
  }
  for (let j = i - 1; j >= 0; j--) {
    const it = items[j];
    if (it.k === "w") return it.e;
  }
  return 0;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/**
 * Zamanlı belgeyi panoya/AI'a uygun metne çevirir.
 * - "markdown": kelimeler zamanlarıyla + notlar + resimler (açıklama satırıyla birlikte)
 * - "text": yalnızca zamanlı kelimeler
 */
export function exportTimed(
  doc: TimedDoc | null,
  meta: Record<string, ImageMeta>,
  mode: CopyMode,
  disfluent?: ReadonlyMap<string, DisfluencyKind>,
): string {
  if (!doc || !doc.items.length) return "";
  const full = mode === "markdown";
  const marks = full ? disfluent : undefined;
  const out: string[] = [];
  if (full) {
    out.push(
      "Aşağıdaki metin kelime kelime zamanlı bir altyazıdır; her kelimenin önündeki [dakika:saniye.salise] o kelimenin başlangıç zamanıdır.",
      "\"[NOT ...]\" ve \"[RESİM ...]\" ile başlayan satırlar konuşma değil, yazarın eklediği notlar ve görsellerdir; altyazı metni olarak değil, yazarın yorumu/ekleri olarak ele al.",
    );
    if (marks?.size) {
      out.push(
        "⟦GEREKSİZ …⟧ içine alınmış kelimeler gereksizdir: dolgu sesi/kelimesi (ıı, ee, şey, yani…), gereksiz tekrar ya da konuşmacının yarım bırakıp yeniden söylediği öbek. Bunlar videoda kesilecek; anlatımın parçası sayma, metne/senaryoya dahil etme.",
      );
    }
    out.push("");
  }
  let line: string[] = [];
  // Art arda gelen aynı türdeki gereksiz kelimeler tek ⟦…⟧ içinde toplanır.
  let run: { kind: DisfluencyKind; words: string[] } | null = null as { kind: DisfluencyKind; words: string[] } | null;
  const endRun = () => {
    if (run) line.push(`⟦GEREKSİZ ${DISFLUENCY_TAG[run.kind]}: ${run.words.join(" ")}⟧`);
    run = null;
  };
  const flush = () => {
    endRun();
    if (line.length) out.push(line.join(" "));
    line = [];
  };
  doc.items.forEach((it, i) => {
    if (it.k === "w") {
      const word = `[${fmtTime(it.s)}] ${it.w}`;
      const kind = marks?.get(it.id);
      if (!kind) {
        endRun();
        line.push(word);
        return;
      }
      if (run && run.kind !== kind) endRun();
      run ??= { kind, words: [] };
      run.words.push(word);
    } else if (it.k === "br") {
      flush();
    } else if (full && it.k === "note") {
      const text = oneLine(it.text);
      if (!text) return;
      flush();
      out.push(`[NOT @${fmtTime(anchorTime(doc.items, i))}${it.approx ? " (konum yaklaşık)" : ""}]: ${text}`);
    } else if (full && it.k === "img") {
      flush();
      out.push(`[RESİM @${fmtTime(anchorTime(doc.items, i))}${it.approx ? " (konum yaklaşık)" : ""}]: ${it.name} (${it.path})`);
      const note = oneLine(meta[it.path]?.note ?? "");
      if (note) out.push(`[RESİM NOTU]: ${note}`);
    }
  });
  flush();
  return out.join("\n").trim() + "\n";
}

const DISFLUENCY_TAG: Record<DisfluencyKind, string> = { filler: "dolgu", repeat: "tekrar", retake: "yarım/yeniden söylenen", manual: "işaretli" };

/** Zamanlı belgede referanslanan resim yolları. */
export function collectTimedPaths(doc: TimedDoc | null | undefined): Set<string> {
  const set = new Set<string>();
  for (const it of doc?.items ?? []) if (it.k === "img") set.add(it.path);
  return set;
}

export const newId = () => crypto.randomUUID();

/** Eski kayıtlarda kelime kimliği olmayabilir; eksikleri tamamlar. */
export function normalizeTimed(doc: TimedDoc): TimedDoc {
  const items = doc.items.map((it) => (it.k === "w" && !it.id ? { ...it, id: newId() } : it));
  return { ...doc, items };
}

/** Öğeyi `from` konumundan `pos` ekleme noktasına taşır (pos: öğenin önüne eklenir). */
export function moveItem(items: TimedItem[], from: number, pos: number): TimedItem[] {
  if (from < 0 || from >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  const target = Math.max(0, Math.min(pos > from ? pos - 1 : pos, next.length));
  next.splice(target, 0, moved);
  return next;
}

/** Bir kelimenin metnini değiştirir; zamanları aynı kalır. */
export function setWordText(items: TimedItem[], id: string, text: string): TimedItem[] {
  return items.map((it) => (it.k === "w" && it.id === id ? { ...it, w: text } : it));
}

/** Kelime kimliği → sıra numarası (1'den başlar), AI'a gönderilen kısa numaralar için. */
export function wordNumbers(items: TimedItem[]): { n: number; id: string; w: string; s: number }[] {
  const out: { n: number; id: string; w: string; s: number }[] = [];
  for (const it of items) if (it.k === "w") out.push({ n: out.length + 1, id: it.id, w: it.w, s: it.s });
  return out;
}

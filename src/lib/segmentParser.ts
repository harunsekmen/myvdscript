import type { Segment, SentenceMark } from "./types";

// `### [KONU: başlık]` — köşeli parantez, iki nokta ve # sayısı konusunda toleranslı.
const HEADING = /^\s*#{1,6}\s*\[?\s*(?:KONU|Konu|konu|TOPIC|Topic)\s*[:：-]?\s*(.*?)\s*\]?\s*$/;

// AI çıktısındaki `[dk:sn]` zaman işareti (altyazı satırının/cümlenin videodaki zamanı).
const MARK = /\[(\d{1,4}):(\d{2})\][ \t]*/g;

/**
 * Bir paragrafı temiz metne çevirir ve her zaman işaretinin temiz metindeki konumunu verir.
 * Paragraf sınırları ve çıktı, paragraphsOf ile birebir aynıdır: işaretsiz boş paragraflar elenir,
 * onların işaretleri bir sonraki paragrafın başına (start 0) taşınır.
 */
export function splitParas(text: string): { text: string; marks: SentenceMark[] }[] {
  const out: { text: string; marks: SentenceMark[] }[] = [];
  let pending: number[] = [];
  for (const raw of text.split(/\n{2,}/)) {
    let joined = "";
    const found: { start: number; t: number }[] = [];
    let last = 0;
    for (const m of raw.matchAll(MARK)) {
      joined += raw.slice(last, m.index);
      found.push({ start: joined.length, t: Number(m[1]) * 60 + Number(m[2]) });
      last = (m.index ?? 0) + m[0].length;
    }
    joined += raw.slice(last);
    const lead = joined.length - joined.trimStart().length;
    const clean = joined.replace(/\n/g, " ").trim();
    if (!clean) {
      pending.push(...found.map((f) => f.t));
      continue;
    }
    const marks: SentenceMark[] = [
      ...pending.map((t) => ({ para: out.length, start: 0, t })),
      ...found.map((f) => ({ para: out.length, start: Math.min(clean.length, Math.max(0, f.start - lead)), t: f.t })),
    ];
    pending = [];
    out.push({ text: clean, marks });
  }
  return out;
}

export function parseSegments(text: string): Segment[] {
  const segs: { title: string; lines: string[] }[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      cur = { title: m[1].trim() || "Bölüm", lines: [] };
      segs.push(cur);
    } else {
      if (!cur) {
        if (!line.trim()) continue;
        cur = { title: "Metin", lines: [] };
        segs.push(cur);
      }
      cur.lines.push(line);
    }
  }
  return segs
    .map((s) => {
      const raw = s.lines.join("\n").trim();
      const marks = splitParas(raw).flatMap((p) => p.marks);
      const clean = raw.replace(MARK, "").trim();
      return { title: s.title, text: clean, ...(marks.length ? { marks } : {}) };
    })
    .filter((s, i, a) => s.text || i === a.length - 1) // akış sırasında son boş başlık görünsün
    .map((s, i) => ({ id: `s${i}`, ...s }));
}

/** Bölümleri, parseSegments'in tanıyacağı `### [KONU: başlık]` biçiminde metne geri çevirir. */
export function segmentsToMarkdown(segs: Segment[]): string {
  return segs.map((s) => `### [KONU: ${s.title}]\n\n${withMarks(s)}`).join("\n\n");
}

/** Cümle zamanlarını metne `[dk:sn]` olarak geri yazar (özel istem yeniden çalıştırmada kaybolmasın). */
function withMarks(s: Segment): string {
  if (!s.marks?.length) return s.text;
  let k = 0;
  return s.text
    .split(/\n{2,}/)
    .map((raw) => {
      if (!raw.replace(/\n/g, " ").trim()) return raw;
      const lead = raw.length - raw.trimStart().length;
      const ms = s.marks!.filter((m) => m.para === k).sort((a, b) => b.start - a.start);
      k++;
      let out = raw;
      for (const m of ms) {
        const at = lead + m.start;
        const sec = Math.floor(m.t);
        const tag = `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}] `;
        out = out.slice(0, at) + tag + out.slice(at);
      }
      return out;
    })
    .join("\n\n");
}

/**
 * Seçilen aralığın orijinal ses karşılığı: başlangıç, seçimi içeren cümlenin zamanı;
 * bitiş, seçimden sonra başlayan ilk cümlenin zamanı (yoksa undefined → sınırsız).
 * Hiç zaman yoksa null döner.
 */
export function audioRange(
  marks: SentenceMark[] | undefined,
  sel: { para: number; start: number; end: number },
): { from: number; to?: number } | null {
  if (!marks?.length) return null;
  const before = (m: SentenceMark, p: number, s: number) => m.para < p || (m.para === p && m.start <= s);
  let from = marks[0];
  for (const m of marks) if (before(m, sel.para, sel.start)) from = m;
  const after = marks.find((m) => m.para > sel.para || (m.para === sel.para && m.start >= sel.end));
  return { from: from.t, to: after && after.t > from.t ? after.t : undefined };
}

/** Bir konumdaki (paragraf, karakter) cümlenin zamanı: en son işaret; yoksa ilk işaret. */
export function markTimeAt(marks: SentenceMark[] | undefined, para: number, start: number): number | null {
  if (!marks?.length) return null;
  let t: number | null = marks[0].t;
  for (const m of marks) if (m.para < para || (m.para === para && m.start <= start)) t = m.t;
  return t;
}

/** Oynatma zamanındaki cümlenin paragraf içi aralığı (vurgulamak için). */
export function sentenceAtTime(
  marks: SentenceMark[] | undefined,
  paraLens: number[],
  time: number,
): { para: number; start: number; end: number } | null {
  if (!marks?.length) return null;
  let i = -1;
  for (let k = 0; k < marks.length; k++) if (marks[k].t <= time) i = k;
  if (i < 0) return null;
  const m = marks[i];
  const next = marks[i + 1];
  const end = next && next.para === m.para ? next.start : paraLens[m.para] ?? m.start;
  return { para: m.para, start: m.start, end: Math.max(end, m.start) };
}

export function paragraphsOf(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
}

/** Uzun metni kelime sınırında ~max karakterlik parçalara böler. */
export function chunkText(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + w.length + 1 > max) {
      // cümle sonuna denk gelmiyorsa biraz daha ilerlemeyi dene (en fazla %15)
      if (!/[.!?…]["')]?$/.test(cur) && cur.length < max * 1.15) {
        cur += " " + w;
        continue;
      }
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Oynatma zamanında çalan çevrilmiş (Türkçe) cümle: tüm bölümler içinde başlangıcı `time`'dan önce olan en son cümle.
 * Zaman işareti olmayan bölümler atlanır; hiç yoksa boş döner.
 */
export function translatedSentenceAt(segments: { text: string; marks?: SentenceMark[] }[], time: number): string {
  let best: { t: number; text: string } | null = null;
  for (const s of segments) {
    if (!s.marks?.length) continue;
    const paras = paragraphsOf(s.text);
    const r = sentenceAtTime(s.marks, paras.map((p) => p.length), time);
    if (!r) continue;
    const t = markTimeAt(s.marks, r.para, r.start) ?? 0;
    if (!best || t > best.t) best = { t, text: (paras[r.para] ?? "").slice(r.start, r.end).trim() };
  }
  return best?.text ?? "";
}

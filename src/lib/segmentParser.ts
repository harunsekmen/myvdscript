import type { Segment } from "./types";

// `### [KONU: başlık]` — köşeli parantez, iki nokta ve # sayısı konusunda toleranslı.
const HEADING = /^\s*#{1,6}\s*\[?\s*(?:KONU|Konu|konu|TOPIC|Topic)\s*[:：-]?\s*(.*?)\s*\]?\s*$/;

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
    .map((s) => ({ title: s.title, text: s.lines.join("\n").trim() }))
    .filter((s, i, a) => s.text || i === a.length - 1) // akış sırasında son boş başlık görünsün
    .map((s, i) => ({ id: `s${i}`, ...s }));
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

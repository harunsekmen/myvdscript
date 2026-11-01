/**
 * Altyazı dosyalarından (SRT/VTT) kaynak → çeviri örnek çifti adayları üretir.
 * Zaman damgalarına göre hizalar; sonuçlar kullanıcı tarafından gözden geçirilip seçilmek üzere önerilir.
 */

export interface Cue {
  start: number; // saniye
  end: number;
  text: string;
}

export interface Sentence {
  start: number;
  end: number;
  text: string;
}

export interface StylePair {
  start: number;
  source: string;
  target: string;
}

const toSec = (t: string): number => {
  const m = t.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
};

/**
 * SRT ya da VTT metnini ayrıştırır. YouTube'un otomatik altyazıları her satırı bir öncekinin
 * tekrarıyla başlattığı için her kuedan yalnızca son boş olmayan satır alınır ve ardışık tekrarlar atılır.
 */
export function parseCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of raw.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const [a, b] = lines[timing].split("-->");
    const start = toSec(a);
    const end = toSec(b);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const body = lines.slice(timing + 1).map((l) => l.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (!body.length) continue;
    const text = body[body.length - 1];
    const prev = cues[cues.length - 1];
    if (prev && (prev.text === text || prev.text.startsWith(text))) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    if (prev && text.startsWith(prev.text)) {
      // kayan altyazı: önceki satır bu satırın başlangıcıdır, tek kue olarak birleştir
      prev.end = end;
      prev.text = text;
      continue;
    }
    cues.push({ start, end, text });
  }
  return cues;
}

/** Kueleri noktalama işaretine göre cümlelere birleştirir. */
export function toSentences(cues: Cue[]): Sentence[] {
  const out: Sentence[] = [];
  let buf: Sentence | null = null;
  for (const c of cues) {
    if (!buf) buf = { start: c.start, end: c.end, text: c.text };
    else {
      buf.end = c.end;
      buf.text = `${buf.text} ${c.text}`;
    }
    if (/[.?!…]["')\]]?$/.test(buf.text.trim())) {
      out.push({ ...buf, text: buf.text.trim() });
      buf = null;
    }
  }
  if (buf) out.push({ ...buf, text: buf.text.trim() });
  return out;
}

/**
 * Her kaynak (İngilizce) cümlesini, orta noktası en yakın çeviri cümlesine atar;
 * her çeviri cümlesi için atanan kaynak cümleleri birleştirilerek çift üretilir.
 */
export function alignSentences(source: Sentence[], target: Sentence[]): StylePair[] {
  const mid = (x: Sentence) => (x.start + x.end) / 2;
  const groups: string[][] = target.map(() => []);
  for (const s of source) {
    let best = -1;
    let bestDist = Infinity;
    target.forEach((t, i) => {
      const d = Math.abs(mid(s) - mid(t));
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    if (best >= 0) groups[best].push(s.text);
  }
  const pairs: StylePair[] = [];
  target.forEach((t, i) => {
    const src = groups[i].join(" ");
    if (!src || src.length < 30 || t.text.length < 30) return;
    pairs.push({ start: Math.round(mid(t)), source: src, target: t.text });
  });
  return pairs;
}

/** İki altyazı dosyasından örnek çifti adayları üretir. */
export function makeStylePairs(sourceRaw: string, targetRaw: string): StylePair[] {
  return alignSentences(toSentences(parseCues(sourceRaw)), toSentences(parseCues(targetRaw)));
}

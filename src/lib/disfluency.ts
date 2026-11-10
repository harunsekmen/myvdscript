import { type Cut, type CutType, type CutWord, cutWords, detectFillers, detectRepeats, detectRetakes } from "./cutList";
import type { DisfluencyKind, TimedDoc, TimedItem } from "./types";

export const DISFLUENCY_LABEL: Record<DisfluencyKind, string> = {
  filler: "Dolgu",
  repeat: "Tekrar",
  retake: "Yarım bırakılıp yeniden söylendi",
  manual: "Gereksiz (elle işaretlendi)",
};

/** Yerel (kurallı) tespit: kesin dolgular, art arda tekrarlar ve varsayılan seçili yeniden çekimler. */
export function localDisfluent(items: TimedItem[]): Map<string, DisfluencyKind> {
  const words = cutWords(items);
  const out = new Map<string, DisfluencyKind>();
  for (const c of detectRetakes(words)) if (c.defaultOn) c.wordIds.forEach((id) => out.set(id, "retake"));
  for (const c of detectRepeats(words)) c.wordIds.forEach((id) => out.set(id, "repeat"));
  for (const c of detectFillers(words)) if (c.type === "filler") c.wordIds.forEach((id) => out.set(id, "filler"));
  return out;
}

/** Gösterilecek/kopyalanacak gereksiz kelimeler: yerel + AI + elle işaret, "gereksiz değil" denenler hariç. */
export function disfluentWords(doc: TimedDoc | null | undefined): Map<string, DisfluencyKind> {
  if (!doc) return new Map();
  const out = localDisfluent(doc.items);
  for (const [id, k] of Object.entries(doc.disfluent ?? {})) out.set(id, k);
  keepFinalTakes(cutWords(doc.items), out);
  for (const id of doc.keepWords ?? []) out.delete(id);
  return out;
}

const TAKE_KINDS = new Set<DisfluencyKind>(["retake", "repeat"]);

/** `b`'nin başı `a`'nın başını tekrar ediyor mu (aynı ilk kelime + ilk ~8 kelimede yüksek benzerlik)? */
function restarts(a: CutWord[], b: CutWord[]): boolean {
  if (!a.length || !b.length || !a[0].n || a[0].n !== b[0].n) return false;
  const L = Math.min(8, a.length, b.length);
  let same = 0;
  for (let k = 0; k < L; k++) if (a[k].n === b[k].n) same++;
  if (L === 1) return a.length === 1;
  return same / L >= 0.6;
}

/**
 * Güvenlik kuralı: bir cümle birkaç kez söylendiğinde EN SON söylenen hali korunur.
 * Ardışık tekrar/yeniden çekim işaretli kelime öbeğinin arkasından aynı başlangıç gelmiyorsa
 * (yani son deneme de işaretlenmişse), öbek içindeki son yeniden başlangıçtan itibaren işaret kaldırılır.
 */
export function keepFinalTakes(words: CutWord[], marks: Map<string, DisfluencyKind>): void {
  let i = 0;
  while (i < words.length) {
    const k = marks.get(words[i].id);
    if (!k || !TAKE_KINDS.has(k)) {
      i++;
      continue;
    }
    let j = i;
    while (j < words.length && TAKE_KINDS.has(marks.get(words[j].id) as DisfluencyKind)) j++;
    const run = words.slice(i, j);
    // Arkasından gelen (işaretsiz) metin aynı cümleyle başlıyorsa son hali zaten korunuyor.
    const after = words.slice(j, j + 8).filter((w) => !marks.has(w.id));
    if (!restarts(run, after)) {
      for (let p = run.length - 1; p > 0; p--) {
        if (restarts(run.slice(0, p), run.slice(p))) {
          run.slice(p).forEach((w) => marks.delete(w.id));
          break;
        }
      }
    }
    i = j;
  }
}

/** Bir kelimeyi elle gereksiz işaretler ya da işareti kaldırır. */
export function toggleDisfluent(doc: TimedDoc, id: string, mark: boolean): TimedDoc {
  const dis = { ...(doc.disfluent ?? {}) };
  const keep = (doc.keepWords ?? []).filter((x) => x !== id);
  if (mark) {
    if (!disfluentWords({ ...doc, disfluent: dis, keepWords: keep }).has(id)) dis[id] = "manual";
  } else {
    delete dis[id];
    if (localDisfluent(doc.items).has(id)) keep.push(id);
  }
  return { ...doc, disfluent: dis, keepWords: keep };
}

const KINDS = new Set<DisfluencyKind>(["filler", "repeat", "retake"]);

/**
 * AI yanıtındaki "drop" listesini ayıklar. Her öğe tek kelime ({n, t}) ya da aralık ({from, to, t}) olabilir.
 * Numara → kelime kimliği eşlemesi `words` ile yapılır; geçersizler atlanır.
 */
export function parseDrops(text: string, words: { n: number; id: string }[]): Record<string, DisfluencyKind> {
  const out: Record<string, DisfluencyKind> = {};
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let drops: unknown;
  try {
    drops = (JSON.parse(text.slice(start, end + 1)) as { drop?: unknown }).drop;
  } catch {
    return out;
  }
  if (!Array.isArray(drops)) return out;
  const byN = new Map(words.map((w) => [w.n, w.id]));
  for (const d of drops as { n?: unknown; from?: unknown; to?: unknown; t?: unknown }[]) {
    const kind = (KINDS.has(d?.t as DisfluencyKind) ? d.t : "filler") as DisfluencyKind;
    const a = Number(d?.n ?? d?.from);
    const b = Number(d?.n ?? d?.to ?? d?.from);
    if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 60) continue;
    for (let n = a; n <= b; n++) {
      const id = byN.get(n);
      if (id) out[id] = kind;
    }
  }
  return out;
}

const CUT_TYPE: Record<DisfluencyKind, CutType> = { filler: "filler", repeat: "repeat", retake: "retake", manual: "filler" };

/**
 * Kurallı tespitin kaçırdığı (AI ya da elle işaretlenmiş) gereksiz kelimeleri kesim önerisine çevirir.
 * Art arda aynı türdeki kelimeler tek öneride birleşir; zaten bir kesim önerisinde olanlar atlanır.
 */
export function extraCuts(doc: TimedDoc, existing: Cut[]): Cut[] {
  const covered = new Set(existing.flatMap((c) => c.wordIds));
  const marks = disfluentWords(doc);
  const out: Cut[] = [];
  let run: { kind: DisfluencyKind; words: { id: string; w: string; s: number; e: number }[] } | null = null;
  const flush = () => {
    if (!run) return;
    const ws = run.words;
    out.push({
      id: `ai:${ws[0].id}`,
      type: CUT_TYPE[run.kind],
      start: ws[0].s,
      end: Math.max(ws[ws.length - 1].e, ws[ws.length - 1].s),
      wordIds: ws.map((w) => w.id),
      anchorId: ws[0].id,
      text: ws.map((w) => w.w).join(" "),
      defaultOn: true,
    });
    run = null;
  };
  for (const it of doc.items) {
    if (it.k !== "w") continue;
    const kind = marks.get(it.id);
    if (!kind || covered.has(it.id)) {
      flush();
      continue;
    }
    if (run && run.kind !== kind) flush();
    run ??= { kind, words: [] };
    run.words.push(it);
  }
  flush();
  return out;
}

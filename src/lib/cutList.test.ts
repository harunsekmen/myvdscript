import { describe, expect, it } from "vitest";
import {
  acceptedRanges, buildCuts, cutWordIds, cutsToText, detectFillers, detectRepeats, detectRetakes, detectSilences, cutWords,
  isCutOn, keptRanges, mergeRanges, normWord, setCutOn, timecode, toEdl, toFcpxml,
} from "./cutList";
import type { TimedItem } from "./types";

/** Kelimeleri sırayla üretir (her biri 0.3 sn); varsayılan boşluk 0.1 sn, [kelime, boşluk] ile değiştirilir. */
function mk(spec: (string | [string, number])[], start = 0): TimedItem[] {
  let t = start;
  return spec.map((x, i) => {
    const [text, gap] = typeof x === "string" ? [x, 0.1] : x;
    if (i > 0) t += gap;
    const it: TimedItem = { k: "w", id: "w" + i, w: text, s: t, e: t + 0.3 };
    t += 0.3;
    return it;
  });
}
const words = (items: TimedItem[]) => cutWords(items);

describe("normWord", () => {
  it("noktalama, büyük harf, tekrarlı harf", () => {
    expect(normWord("Iıııı,")).toBe("ı");
    expect(normWord("Hmmm...")).toBe("hm");
    expect(normWord("EEE")).toBe("e");
    expect(normWord("İşte,")).toBe("işte");
  });
});

describe("sessizlik", () => {
  it("eşikten uzun boşlukta pay bırakarak keser", () => {
    const items = mk(["a", ["b", 2], "c"]);
    const w = words(items);
    const c = detectSilences(w, 1.5);
    expect(c).toHaveLength(1);
    expect(c[0].start).toBeCloseTo(w[0].e + 0.15);
    expect(c[0].end).toBeCloseTo(w[1].s - 0.15);
    expect(detectSilences(w, 2.5)).toHaveLength(0);
  });
});

describe("dolgu", () => {
  it("dolgu ve olası dolgu ayrılır", () => {
    const c = detectFillers(words(mk(["ııı,", "Bugün", "eee", "yani", "Hmmm", "um", "şey"])));
    expect(c.map((x) => [x.text, x.type, x.defaultOn])).toEqual([
      ["ııı,", "filler", true],
      ["eee", "filler", true],
      ["yani", "maybe", false],
      ["Hmmm", "filler", true],
      ["um", "filler", true],
      ["şey", "maybe", false],
    ]);
  });
});

describe("tekrar kelime", () => {
  it("bu bu → öndeki", () => {
    const c = detectRepeats(words(mk(["bu", "bu", "güzel"])));
    expect(c).toHaveLength(1);
    expect(c[0].wordIds).toEqual(["w0"]);
  });
});

describe("yeniden çekim", () => {
  it("cümle başı tekrarlanınca ilk deneme kesilir", () => {
    const items = mk(["Merhaba", "arkadaşlar", "bugün", "size", ["Merhaba", 0.8], "arkadaşlar", "bugün", "size", "bir", "şey", "anlatacağım"]);
    const c = detectRetakes(words(items));
    expect(c).toHaveLength(1);
    expect(c[0].start).toBe(0);
    expect(c[0].wordIds).toEqual(["w0", "w1", "w2", "w3"]);
    expect(c[0].end).toBeCloseTo((items[4] as { s: number }).s);
    expect(c[0].defaultOn).toBe(true);
  });
  it("zincirleme üç deneme", () => {
    const take = ["bugün", "hava", "çok", "güzel"];
    const again = take.map((t, i): string | [string, number] => (i === 0 ? [t, 0.6] : t));
    const items = mk([...take, ...again, ...again, "dedim"]);
    expect(detectRetakes(words(items))).toHaveLength(2);
  });
  it("alakasız cümlede yok", () => {
    expect(detectRetakes(words(mk(["bu", "bir", "test", "ama", "başka", "şeyler", "söylüyorum"])))).toHaveLength(0);
  });
  it("duraklamasız eşleşme varsayılan kapalı", () => {
    const c = detectRetakes(words(mk(["merhaba", "arkadaşlar", "bugün", "merhaba", "arkadaşlar", "bugün", "nasılsınız"])));
    expect(c).toHaveLength(1);
    expect(c[0].defaultOn).toBe(false);
  });
});

describe("birleştirme ve tersi", () => {
  it("örtüşenleri birleştirir", () => {
    expect(mergeRanges([{ start: 5, end: 6 }, { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 4, end: 4.5 }])).toEqual([
      { start: 1, end: 4.5 },
      { start: 5, end: 6 },
    ]);
  });
  it("korunan aralıklar", () => {
    expect(keptRanges([{ start: 0, end: 1 }, { start: 3, end: 4 }, { start: 3.5, end: 5 }], 10)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 10 },
    ]);
    expect(keptRanges([], 10)).toEqual([{ start: 0, end: 10 }]);
    expect(keptRanges([{ start: 0, end: 10 }], 10)).toEqual([]);
  });
});

describe("tercihler", () => {
  it("varsayılan, on/off", () => {
    const items = mk(["ııı", "yani"]);
    const [f, m] = buildCuts(items);
    expect(isCutOn(f, undefined)).toBe(true);
    expect(isCutOn(m, undefined)).toBe(false);
    let p = setCutOn(undefined, m, true);
    expect(isCutOn(m, p)).toBe(true);
    p = setCutOn(p, f, false);
    expect(isCutOn(f, p)).toBe(false);
    p = setCutOn(p, f, true);
    expect(p.off).toEqual([]);
    expect(acceptedRanges([f, m], p)).toHaveLength(2);
  });
  it("kesilen kelimeler", () => {
    const items = mk(["a", "ııı", "b"]);
    const ids = cutWordIds(items, acceptedRanges(buildCuts(items), undefined));
    expect([...ids]).toEqual(["w1"]);
  });
  it("kimlikler kararlı", () => {
    const items = mk(["ııı", "bu", "bu"]);
    expect(buildCuts(items).map((c) => c.id)).toEqual(buildCuts(items).map((c) => c.id));
  });
});

describe("dışa aktarma", () => {
  it("timecode", () => {
    expect(timecode(0, 30)).toBe("00:00:00:00");
    expect(timecode(1.5, 30)).toBe("00:00:01:15");
    expect(timecode(3661, 25)).toBe("01:01:01:00");
    expect(timecode(59.99, 24)).toBe("00:01:00:00");
  });
  it("EDL", () => {
    const edl = toEdl([{ start: 0, end: 2 }, { start: 3, end: 4 }], { title: "T", clip: "ses.mp3", fps: 30 });
    expect(edl).toContain("TITLE: T\nFCM: NON-DROP FRAME");
    expect(edl).toContain("001  AX       V     C        00:00:00:00 00:00:02:00 01:00:00:00 01:00:02:00");
    expect(edl).toContain("002  AX       A     C        00:00:03:00 00:00:04:00 01:00:02:00 01:00:03:00");
    expect(edl).toContain("* FROM CLIP NAME: ses.mp3");
  });
  it("FCPXML", () => {
    const x = toFcpxml([{ start: 0, end: 2 }, { start: 3, end: 4 }], { name: "A&B", clip: "ses.mp3", fps: 30, duration: 10 });
    expect(x).toContain('<fcpxml version="1.9">');
    expect(x).toContain('offset="60/30s" name="A&amp;B" start="90/30s" duration="30/30s"');
    expect(x).toContain('duration="90/30s" tcStart="0s"');
  });
  it("metin listesi", () => {
    expect(cutsToText(buildCuts(mk(["ııı", "a"])))).toContain("[Dolgu]  ııı");
  });
});

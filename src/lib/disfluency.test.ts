import { describe, expect, it } from "vitest";
import { buildCuts } from "./cutList";
import { disfluentWords, extraCuts, localDisfluent, parseDrops, toggleDisfluent } from "./disfluency";
import { exportTimed } from "./timed";
import type { TimedDoc, TimedItem } from "./types";

const doc = (words: string[], extra: Partial<TimedDoc> = {}): TimedDoc => ({
  source: "a.mp4",
  lang: "tr",
  items: words.map((w, i): TimedItem => ({ k: "w", id: `w${i + 1}`, w, s: i, e: i + 0.5 })),
  ...extra,
});

describe("gereksiz kelimeler", () => {
  it("yerel kurallar dolgu ve tekrarı bulur, olası dolguyu bulmaz", () => {
    const m = localDisfluent(doc(["ıı", "bu", "bu", "şey", "güzel"]).items);
    expect(m.get("w1")).toBe("filler");
    expect(m.get("w2")).toBe("repeat");
    expect(m.has("w3")).toBe(false);
    expect(m.has("w4")).toBe(false);
  });

  it("AI işaretleri eklenir, 'gerekli' denenler çıkarılır", () => {
    const d = doc(["ıı", "yani", "harika"], { disfluent: { w2: "filler" }, keepWords: ["w1"] });
    const m = disfluentWords(d);
    expect([...m.keys()]).toEqual(["w2"]);
  });

  it("AI bir cümlenin tüm tekrarlarını işaretlese de en son söylenen hali kalır", () => {
    const sent = "TypeScript'te olan iki şeyi size hızlıca göstermek istiyorum".split(" ");
    const words = [...sent, ...sent, "Böylece", "bu"];
    const all: Record<string, "retake"> = {};
    for (let i = 1; i <= sent.length * 2; i++) all[`w${i}`] = "retake";
    const m = disfluentWords(doc(words, { disfluent: all }));
    for (let i = 1; i <= sent.length; i++) expect(m.get(`w${i}`)).toBe("retake");
    for (let i = sent.length + 1; i <= sent.length * 2; i++) expect(m.has(`w${i}`)).toBe(false);
  });

  it("son hali zaten işaretsizse ve yarım kalan deneme tekse dokunulmaz", () => {
    const words = ["bugün", "size", "bugün", "size", "iki", "şey", "anlatacağım"];
    const m = disfluentWords(doc(words, { disfluent: { w1: "retake", w2: "retake" } }));
    expect(m.get("w1")).toBe("retake");
    expect(m.get("w2")).toBe("retake");
    expect(m.has("w3")).toBe(false);
    const solo = disfluentWords(doc(["aslında", "şöyle", "bir", "konu", "anlatayım"], { disfluent: { w1: "retake", w2: "retake" } }));
    expect(solo.has("w1") && solo.has("w2")).toBe(true);
  });

  it("art arda tekrarın ikisi de işaretlenmişse sonuncusu kalır", () => {
    const m = disfluentWords(doc(["çok", "çok", "güzel"], { disfluent: { w1: "repeat", w2: "repeat" } }));
    expect(m.get("w1")).toBe("repeat");
    expect(m.has("w2")).toBe(false);
  });

  it("elle işaretleme ve kaldırma", () => {
    let d = doc(["ıı", "harika"]);
    d = toggleDisfluent(d, "w2", true);
    expect(disfluentWords(d).get("w2")).toBe("manual");
    d = toggleDisfluent(d, "w2", false);
    expect(disfluentWords(d).has("w2")).toBe(false);
    d = toggleDisfluent(d, "w1", false);
    expect(d.keepWords).toEqual(["w1"]);
    expect(disfluentWords(d).has("w1")).toBe(false);
    d = toggleDisfluent(d, "w1", true);
    expect(disfluentWords(d).get("w1")).toBe("filler");
  });

  it("AI yanıtından tek kelime ve aralıkları ayıklar", () => {
    const words = [1, 2, 3, 4, 5].map((n) => ({ n, id: `w${n}` }));
    const out = parseDrops('tamam {"fixes":[],"drop":[{"n":1,"t":"filler"},{"from":3,"to":4,"t":"retake"},{"n":99},{"from":5,"to":2}]}', words);
    expect(out).toEqual({ w1: "filler", w3: "retake", w4: "retake" });
    expect(parseDrops("bozuk", words)).toEqual({});
    expect(parseDrops('{"fixes":[]}', words)).toEqual({});
  });

  it("kurallı kesimin kaçırdıklarını ardışık gruplarla kesim önerisine çevirir", () => {
    const d = doc(["ıı", "ben", "dedim", "ki", "harika"], { disfluent: { w2: "retake", w3: "retake", w5: "manual" } });
    const base = buildCuts(d.items);
    const extra = extraCuts(d, base);
    expect(extra.map((c) => c.wordIds)).toEqual([["w2", "w3"], ["w5"]]);
    expect(extra[0].type).toBe("retake");
    // "ıı" zaten kurallı kesimde var: tekrar eklenmez
    expect(extra.some((c) => c.wordIds.includes("w1"))).toBe(false);
  });
});

describe("markdown kopyada gereksiz kelimeler", () => {
  it("ardışık aynı türler tek blokta işaretlenir ve açıklama eklenir", () => {
    const d = doc(["ıı", "ee", "bu", "bu", "güzel"]);
    const out = exportTimed(d, {}, "markdown", disfluentWords(d));
    expect(out).toContain("⟦GEREKSİZ …⟧");
    expect(out).toContain("⟦GEREKSİZ dolgu: [00:00.00] ıı [00:01.00] ee⟧ ⟦GEREKSİZ tekrar: [00:02.00] bu⟧ [00:03.00] bu [00:04.00] güzel");
  });

  it("düz metin modunda işaret yok", () => {
    const d = doc(["ıı", "güzel"]);
    expect(exportTimed(d, {}, "text", disfluentWords(d))).toBe("[00:00.00] ıı [00:01.00] güzel\n");
  });

  it("işaret yoksa açıklama satırı eklenmez", () => {
    const d = doc(["güzel"]);
    expect(exportTimed(d, {}, "markdown", disfluentWords(d))).not.toContain("GEREKSİZ");
  });
});

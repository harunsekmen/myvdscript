import { describe, expect, it } from "vitest";
import { alignPunctuation, buildTimeline, encodeWav, fmtDur, locate, moveTake, packBatches, splitWords, takesText, takesToTimed } from "./voice";
import type { VoiceTake } from "./types";

const take = (id: string, duration: number, extra: Partial<VoiceTake> = {}): VoiceTake => ({ id, file: `${id}.webm`, duration, createdAt: 0, ...extra });

describe("voice timeline", () => {
  it("dizilimde parçalar arasına boşluk koyar", () => {
    const { items, total } = buildTimeline([take("a", 2), take("b", 3), take("c", 1)], 500);
    expect(items.map((i) => [i.start, i.end])).toEqual([
      [0, 2],
      [2.5, 5.5],
      [6, 7],
    ]);
    expect(total).toBe(7);
  });

  it("anı parçaya çevirir; boşluk sonraki parçanın başına düşer", () => {
    const { items } = buildTimeline([take("a", 2), take("b", 3)], 500);
    expect(locate(items, 1)).toEqual({ index: 0, offset: 1 });
    expect(locate(items, 2.2)).toEqual({ index: 1, offset: 0 });
    expect(locate(items, 3)).toEqual({ index: 1, offset: 0.5 });
    expect(locate(items, 10)).toBeNull();
  });

  it("süre biçimi", () => {
    expect(fmtDur(65.9)).toBe("1:05");
    expect(fmtDur(3723)).toBe("1:02:03");
  });

  it("taşıma", () => {
    expect(moveTake([1, 2, 3, 4], 0, 3)).toEqual([2, 3, 1, 4]);
    expect(moveTake([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveTake([1, 2, 3], 1, 2)).toEqual([1, 2, 3]);
    expect(moveTake([1, 2, 3], 0, 3)).toEqual([2, 3, 1]);
  });
});

describe("voice → zamanlı metin", () => {
  const link = { sourceId: "s", segmentId: "g1", title: "Giriş" };
  const takes = [
    take("a", 2, { link, stt: { lang: "tr", text: "Merhaba dünya", words: [{ w: "Merhaba", s: 0.1, e: 0.6 }, { w: "dünya", s: 0.7, e: 1.2 }] } }),
    take("b", 3), // yazıya çevrilmemiş
    take("c", 2, { link, stt: { lang: "tr", text: "Selam", words: [{ w: "Selam", s: 0.5, e: 1 }] } }),
  ];

  it("kelimeleri birleşik kayda göre kaydırır, parçalar arasına satır sonu koyar", () => {
    const doc = takesToTimed(takes, 1000, "Ses kayıtları");
    expect(doc.lang).toBe("tr");
    const kinds = doc.items.map((i) => i.k);
    expect(kinds).toEqual(["note", "w", "w", "br", "w"]);
    const words = doc.items.filter((i) => i.k === "w") as { s: number; e: number; w: string }[];
    expect(words[0].s).toBeCloseTo(0.1);
    // c parçası: 2 + 1 + 3 + 1 = 7. saniyede başlar
    expect(words[2].s).toBeCloseTo(7.5);
    expect(words[2].e).toBeCloseTo(8);
  });

  it("düz metin yalnız çevrilmiş parçaları içerir", () => {
    expect(takesText(takes)).toEqual(["Merhaba dünya", "Selam"]);
  });
});

describe("wav", () => {
  it("başlık ve örnekler", () => {
    const w = encodeWav(new Float32Array([0, 1, -1]), 48000);
    expect(w.length).toBe(44 + 6);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
  });
});

describe("paragraflar", () => {
  it("ardışık aynı bölüm parçalarını gruplar", async () => {
    const { groupTakes } = await import("./voice");
    const l = (segmentId: string) => ({ sourceId: "s", segmentId, title: segmentId.toUpperCase() });
    const items = [take("a", 1, { link: l("x") }), take("b", 1, { link: l("x") }), take("c", 1), take("d", 1, { link: l("x") })].map((t) => ({ take: t }));
    const g = groupTakes(items);
    expect(g.map((p) => [p.segmentId, p.items.length])).toEqual([
      ["x", 2],
      [null, 1],
      ["x", 1],
    ]);
    expect(g[0].title).toBe("X");
  });
});

describe("kısayollar", () => {
  it("olaydan metin üretir ve eşler", async () => {
    const { comboFromEvent, matchCombo, prettyCombo } = await import("./keys");
    const ev = (key: string, m: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...m });
    expect(comboFromEvent(ev("M", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+M");
    expect(comboFromEvent(ev(" "))).toBe("Space");
    expect(comboFromEvent(ev("Shift", { shiftKey: true }))).toBeNull();
    expect(matchCombo(ev("r"), "R")).toBe(true);
    expect(matchCombo(ev("R", { shiftKey: true }), "R")).toBe(false);
    expect(matchCombo(ev("R", { shiftKey: true }), "Shift+R")).toBe(true);
    expect(prettyCombo("Ctrl+Space")).toBe("Ctrl+Boşluk");
  });
});

describe("toplu yazıya çevirme", () => {
  it("parçaları süre sınırına göre gruplar", () => {
    const d = (n: number) => ({ duration: n });
    expect(packBatches([d(4), d(4), d(4), d(20), d(1)], 10, 1).map((g) => g.map((x) => x.duration))).toEqual([[4, 4], [4], [20], [1]]);
    expect(packBatches([], 10, 1)).toEqual([]);
  });

  it("kelimeleri orta noktalarına göre parçalara dağıtır", () => {
    const spans = [
      { start: 0, duration: 2 },
      { start: 3, duration: 2 },
    ];
    const words = [
      { word: " Merhaba", start: 0.1, end: 0.6 },
      { word: "dünya.", start: 1.5, end: 2.3 }, // sessizliğin ilk yarısına taşıyor
      { word: "Nasılsın?", start: 2.9, end: 3.6 },
    ];
    const [a, b] = splitWords(words, spans);
    expect(a.map((w) => w.w)).toEqual(["Merhaba", "dünya."]);
    expect(a[1].e).toBe(2); // parça sonuna kırpılır
    expect(b).toEqual([{ w: "Nasılsın?", s: 0, e: expect.closeTo(0.6, 5) }]);
  });

  it("noktalamayı tam metinden alır", () => {
    expect(alignPunctuation("Şimdi açık konuşalım. Bizler, kim?", ["Şimdi", "açık", "konuşalım", "Bizler", "kim"])).toEqual([
      "Şimdi",
      "açık",
      "konuşalım.",
      "Bizler,",
      "kim?",
    ]);
    expect(alignPunctuation("tamamen başka", ["merhaba"])).toEqual(["merhaba"]);
  });
});

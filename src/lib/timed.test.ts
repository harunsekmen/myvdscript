import { describe, expect, it } from "vitest";
import { buildTimed, exportTimed, fmtTime, moveItem, normalizeTimed, splitLines, setWordText } from "./timed";
import { parseFixes } from "./wordCheck";

const W = (word: string, start: number, end: number) => ({ word, start, end });

describe("fmtTime", () => {
  it("dk:sn.salise biçimi", () => {
    expect(fmtTime(12.346)).toBe("00:12.35");
    expect(fmtTime(0)).toBe("00:00.00");
    expect(fmtTime(75.5, 1)).toBe("01:15.5");
    expect(fmtTime(3725.1, 1)).toBe("1:02:05.1");
  });
});

describe("buildTimed", () => {
  it("duraklamada satır böler, boş kelimeleri atlar", () => {
    const doc = buildTimed([W("Merhaba", 0, 0.4), W("dünya", 0.5, 0.9), W("", 1, 1), W("sonra", 3, 3.4)], "a.mp4", "tr");
    const lines = splitLines(doc.items);
    expect(lines.map((l) => l.items.map((x) => (x.item.k === "w" ? x.item.w : "")).join(" "))).toEqual([
      "Merhaba dünya",
      "sonra",
    ]);
    expect(doc.source).toBe("a.mp4");
    expect(doc.lang).toBe("tr");
  });

  it("cümle sonunda satır böler", () => {
    const words = ["bir", "iki", "üç", "dört", "beş", "altı", "yedi.", "sekiz"].map((w, i) => W(w, i * 0.3, i * 0.3 + 0.2));
    const lines = splitLines(buildTimed(words, "x", "tr").items);
    expect(lines.length).toBe(2);
    expect(lines[0].items.length).toBe(7);
  });
});

describe("exportTimed", () => {
  const doc = buildTimed([W("Merhaba", 1, 1.4), W("dünya", 1.5, 1.9)], "x", "tr");

  it("metin modunda not ve resim yok, sadece zamanlı kelimeler", () => {
    doc.items.splice(1, 0, { k: "note", id: "n1", text: "gizli" });
    expect(exportTimed(doc, {}, "text")).toBe("[00:01.00] Merhaba [00:01.50] dünya\n");
  });

  it("markdown modunda notlar açıkça işaretlenir ve açıklama eklenir", () => {
    const d = buildTimed([W("Merhaba", 1, 1.4), W("dünya", 1.5, 1.9)], "x", "tr");
    d.items.splice(1, 0, { k: "note", id: "n1", text: "burada\nvurgu yap" });
    d.items.push({ k: "img", id: "i1", path: "C:\\p\\resim-1.png", name: "resim-1.png" });
    const out = exportTimed(d, { "C:\\p\\resim-1.png": { name: "resim-1.png", note: "grafik" } }, "markdown");
    expect(out).toContain("[NOT @00:01.50]: burada vurgu yap");
    // Resim sona eklendi: sonrasında kelime yok, öncekinin bitişi kullanılır (1.9)
    expect(out).toContain("[RESİM @00:01.90]: resim-1.png (C:\\p\\resim-1.png)");
    expect(out).toContain("[RESİM NOTU]: grafik");
    expect(out).toContain("[00:01.00] Merhaba");
    expect(out.indexOf("[NOT @")).toBeGreaterThan(out.indexOf("[00:01.00] Merhaba"));
  });

  it("boş belge boş döner", () => {
    expect(exportTimed(null, {}, "markdown")).toBe("");
  });
});

describe("moveItem", () => {
  const mk = (n: string) => ({ k: "note" as const, id: n, text: n });
  it("öğeyi geriye taşır", () => {
    const r = moveItem([mk("a"), mk("b"), mk("c")], 2, 0).map((x) => (x as { id: string }).id);
    expect(r).toEqual(["c", "a", "b"]);
  });
  it("öğeyi ileriye taşır (ekleme noktası silinen öğeden sonra hesaplanır)", () => {
    const r = moveItem([mk("a"), mk("b"), mk("c")], 0, 2).map((x) => (x as { id: string }).id);
    expect(r).toEqual(["b", "a", "c"]);
  });
});

describe("normalizeTimed / setWordText", () => {
  it("kimliği olmayan kelimelere kimlik verir, zamanları korur", () => {
    const doc = normalizeTimed({ source: "x", lang: "tr", items: [{ k: "w", id: "", w: "a", s: 1, e: 2 } as any] });
    const w = doc.items[0] as any;
    expect(w.id).toBeTruthy();
    expect(w.s).toBe(1);
  });
  it("kelime metnini değiştirir", () => {
    const items = setWordText([{ k: "w", id: "x", w: "yanlis", s: 0, e: 1 }], "x", "doğru");
    expect(items[0]).toMatchObject({ w: "doğru", s: 0, e: 1 });
  });
});

describe("parseFixes", () => {
  const words = [
    { n: 1, id: "a", w: "merhaba", s: 0 },
    { n: 2, id: "b", w: "dünya", s: 1 },
  ];
  it("geçerli önerileri çıkarır, aynı/boş/bilinmeyenleri atar", () => {
    const text = '```json\n{"fixes":[{"n":2,"to":"dünyaa"},{"n":1,"to":"merhaba"},{"n":9,"to":"x"},{"n":1,"to":"  "}]}\n```';
    expect(parseFixes(text, words)).toEqual({ b: "dünyaa" });
  });
  it("bozuk yanıtta boş döner", () => {
    expect(parseFixes("merhaba", words)).toEqual({});
    expect(parseFixes("{bozuk", words)).toEqual({});
  });
});

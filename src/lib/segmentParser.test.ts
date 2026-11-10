import { describe, expect, it } from "vitest";
import { chunkText, paragraphsOf, parseSegments } from "./segmentParser";

describe("parseSegments", () => {
  it("başlıkları ve paragrafları ayırır", () => {
    const s = parseSegments("### [KONU: Giriş]\nMerhaba.\n\nİkinci.\n### [KONU: Sonuç]\nBitti.");
    expect(s.map((x) => x.title)).toEqual(["Giriş", "Sonuç"]);
    expect(paragraphsOf(s[0].text)).toEqual(["Merhaba.", "İkinci."]);
  });
  it("işaret yoksa tek segment", () => {
    const s = parseSegments("Sadece düz metin.\n\nİki paragraf.");
    expect(s).toHaveLength(1);
    expect(s[0].title).toBe("Metin");
  });
  it("bozuk işaretlere toleranslı", () => {
    const s = parseSegments("## KONU: Başlık Bir\nmetin\n### [Konu - Başlık İki\nmetin 2\n#### [KONU:]\nx");
    expect(s.map((x) => x.title)).toEqual(["Başlık Bir", "Başlık İki", "Bölüm"]);
  });
  it("akış sırasında yarım başlık satırı kırılmaz", () => {
    const s = parseSegments("### [KONU: A]\nmetin\n### [KON");
    expect(s[0].title).toBe("A");
  });
});

describe("chunkText", () => {
  it("parçalara böler ve içeriği korur", () => {
    const t = Array.from({ length: 500 }, (_, i) => `kelime${i}`).join(" ");
    const c = chunkText(t, 400);
    expect(c.length).toBeGreaterThan(5);
    expect(c.join(" ")).toBe(t);
  });
});

describe("translatedSentenceAt", () => {
  const segs = [
    { text: "Merhaba. Nasılsın?\n\nİkinci paragraf.", marks: [{ para: 0, start: 0, t: 1 }, { para: 0, start: 9, t: 3 }, { para: 1, start: 0, t: 6 }] },
    { text: "Zamansız bölüm." },
    { text: "Son bölüm.", marks: [{ para: 0, start: 0, t: 10 }] },
  ];
  it("çalan cümleyi döndürür", async () => {
    const { translatedSentenceAt } = await import("./segmentParser");
    expect(translatedSentenceAt(segs, 0.5)).toBe("");
    expect(translatedSentenceAt(segs, 1.2)).toBe("Merhaba.");
    expect(translatedSentenceAt(segs, 4)).toBe("Nasılsın?");
    expect(translatedSentenceAt(segs, 7)).toBe("İkinci paragraf.");
    expect(translatedSentenceAt(segs, 12)).toBe("Son bölüm.");
  });
});

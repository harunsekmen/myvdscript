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

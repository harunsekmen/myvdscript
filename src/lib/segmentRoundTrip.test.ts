import { describe, expect, it } from "vitest";
import { parseSegments, segmentsToMarkdown } from "./segmentParser";


describe("segmentsToMarkdown", () => {
  it("bölümleri parseSegments'in geri okuyabileceği biçimde yazar", () => {
    const segs = [
      { id: "s0", title: "Giriş konusu", text: "Birinci paragraf.\n\nİkinci paragraf." },
      { id: "s1", title: "Örnek hikâye", text: "Üçüncü paragraf." },
    ];
    const md = segmentsToMarkdown(segs);
    const back = parseSegments(md);
    expect(back.map((s) => [s.title, s.text])).toEqual([
      ["Giriş konusu", "Birinci paragraf.\n\nİkinci paragraf."],
      ["Örnek hikâye", "Üçüncü paragraf."],
    ]);
  });
});

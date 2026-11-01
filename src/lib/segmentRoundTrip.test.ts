import { describe, expect, it } from "vitest";
import { parseSegments, segmentsToMarkdown } from "./segmentParser";
import { buildCustomRunSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompts";

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

describe("buildCustomRunSystemPrompt", () => {
  it("temel sistem istemini korur ve kullanıcı istemini ek olarak sona ekler", () => {
    const p = buildCustomRunSystemPrompt(DEFAULT_SYSTEM_PROMPT, "  Sadeleştir.  ");
    expect(p.startsWith(DEFAULT_SYSTEM_PROMPT.trim())).toBe(true);
    expect(p).toContain("SPONSORLU KISIMLAR");
    expect(p).toContain("TERİMLER VE İSİMLER");
    expect(p.trimEnd().endsWith("Sadeleştir.")).toBe(true);
  });
  it("boş istemde temel istemi aynen döndürür", () => {
    expect(buildCustomRunSystemPrompt(DEFAULT_SYSTEM_PROMPT, "   ")).toBe(DEFAULT_SYSTEM_PROMPT);
  });
  it("varsayılan istemi değiştirmez", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("### [KONU: kısa başlık]");
  });
});

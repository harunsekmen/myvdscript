import { describe, expect, it } from "vitest";
import { buildCustomRunSystemPrompt, buildStyleBlock, buildSystemWithStyle, DEFAULT_SYSTEM_PROMPT, MAX_STYLE_EXAMPLES } from "./prompts";

describe("özel istemle işleme", () => {
  it("örnek çiftleri ve kılavuz, özel istemli işlemeye de eklenir", () => {
    const sys = buildSystemWithStyle({
      systemPrompt: buildCustomRunSystemPrompt(DEFAULT_SYSTEM_PROMPT, "Çocuklar için anlat."),
      styleGuide: "Kısa cümleler kur.",
      styleExamples: [{ source: "Rust is fast.", target: "Rust hızlı." }],
    });
    expect(sys).toContain("Kaynak: Rust is fast.\nÇıktı: Rust hızlı.");
    expect(sys).toContain("Üslup kılavuzu:\nKısa cümleler kur.");
    expect(sys).toContain("Çocuklar için anlat.");
    expect(sys).toContain("SPONSORLU KISIMLAR");
  });
});

describe("anlatım tarzı bloğu", () => {
  it("kılavuz ve örnek yoksa boş döner ve sistem prompt'una dokunmaz", () => {
    expect(buildStyleBlock("  ", [])).toBe("");
    expect(buildSystemWithStyle({ systemPrompt: "Ana istem", styleGuide: "", styleExamples: [] })).toBe("Ana istem");
  });

  it("kılavuzu ve örnek çiftlerini sistem prompt'una ekler", () => {
    const sys = buildSystemWithStyle({
      systemPrompt: "Ana istem",
      styleGuide: "Kısa cümleler kur.",
      styleExamples: [{ source: "Rust is fast.", target: "Rust hızlı." }],
    });
    expect(sys.startsWith("Ana istem\n\nANLATIM TARZI (zorunlu):")).toBe(true);
    expect(sys).toContain("Üslup kılavuzu:\nKısa cümleler kur.");
    expect(sys).toContain("Kaynak: Rust is fast.\nÇıktı: Rust hızlı.");
  });

  it("boş örnek çiftlerini atlar ve üst sınırı uygular", () => {
    const many = Array.from({ length: MAX_STYLE_EXAMPLES + 3 }, (_, i) => ({ source: `S${i}`, target: `T${i}` }));
    const block = buildStyleBlock("", [{ source: " ", target: "T" }, ...many]);
    const count = (block.match(/Örnek \d+/g) ?? []).length;
    expect(count).toBe(MAX_STYLE_EXAMPLES);
    expect(block).not.toContain("Kaynak: \n");
  });

  it("uzun örnekleri kırpar", () => {
    const block = buildStyleBlock("", [{ source: "a".repeat(5000), target: "b" }]);
    expect(block).toContain("a".repeat(1200) + "…");
    expect(block).not.toContain("a".repeat(1201));
  });
});

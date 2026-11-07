import { describe, expect, it } from "vitest";
import { buildCustomRunSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./prompts";

describe("özel istemle işleme", () => {
  it("özel istek temel istemin sonuna eklenir, kurallar düşmez", () => {
    const sys = buildCustomRunSystemPrompt(DEFAULT_SYSTEM_PROMPT, "Çocuklar için anlat.");
    expect(sys.startsWith(DEFAULT_SYSTEM_PROMPT.trim())).toBe(true);
    expect(sys).toContain("Çocuklar için anlat.");
    expect(sys).toContain("SPONSORLU KISIMLAR");
  });

  it("boş özel istek temel istemi değiştirmez", () => {
    expect(buildCustomRunSystemPrompt("Ana", "  ")).toBe("Ana");
  });
});

describe("varsayılan sistem istemi", () => {
  it("özetleme yasağı ve doğal anlatım kuralını içerir", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("ÖZETLEME");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("KELİMESİ KELİMESİNE ÇEVİRİ YAPMA");
  });
});

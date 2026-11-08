import { describe, expect, it } from "vitest";
import { hashString } from "./hash";
import { buildCustomRunSystemPrompt, DEFAULT_SYSTEM_PROMPT, isLegacySystemPrompt, LEGACY_SYSTEM_PROMPT_HASHES } from "./prompts";

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

describe("eski sistem istemi tespiti", () => {
  it("özet fonksiyonu kararlıdır", () => {
    expect(hashString("")).toBe(hashString(""));
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    // Değişirse eski istem listesi geçersiz olur; bu yüzden sabit bir değere sabitlenir.
    expect(hashString("Script Atölyesi")).toBe("32hknxl73k");
  });

  it("güncel varsayılan istem eski listede değildir", () => {
    expect(LEGACY_SYSTEM_PROMPT_HASHES.has(hashString(DEFAULT_SYSTEM_PROMPT))).toBe(false);
    expect(isLegacySystemPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(false);
    expect(isLegacySystemPrompt("kendi istemim")).toBe(false);
    expect(LEGACY_SYSTEM_PROMPT_HASHES.size).toBe(4);
  });
});

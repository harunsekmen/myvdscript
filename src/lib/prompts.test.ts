import { describe, expect, it } from "vitest";
import { hashString } from "./hash";
import { buildEditMessage, DEFAULT_SYSTEM_PROMPT, isLegacySystemPrompt, LEGACY_SYSTEM_PROMPT_HASHES } from "./prompts";

describe("AI metin düzenleme", () => {
  it("mevcut metni, altyazıyı ve talimatı ayrı alanlarda gönderir", () => {
    expect(JSON.parse(buildEditMessage("Mevcut metin", "Ham altyazı", "  Düzelt  "))).toEqual({ mevcutMetin: "Mevcut metin", hamAltyazi: "Ham altyazı", duzenlemeTalimati: "Düzelt" });
  });
  it("altyazı yoksa mevcut metni korur", () => {
    expect(JSON.parse(buildEditMessage("Metin", "", "Düzelt")).hamAltyazi).toBeNull();
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

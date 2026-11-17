import { describe, expect, it } from "vitest";
import { buildStyleSystemPrompt, readStyleFile, STYLE_CONTEXT_CHARS } from "./styleReferences";
import { processTranscript } from "./pipeline";
import { DEFAULT_SETTINGS } from "./settingsDefaults";

const ref = { id: "1", name: "script.md", content: "Peki arkadaşlar, şimdi bakalım.", enabled: true };
const file = (name: string, text: string) => new File([text], name);

describe("stil dosyaları", () => {
  it("Türkçe metni içeriğiyle içe aktarır", async () => {
    expect(await readStyleFile(file("örnek.md", "  Şimdi ışığa bakalım.  "))).toMatchObject({ name: "örnek.md", content: "Şimdi ışığa bakalım.", enabled: true });
  });
  it("boş, ikili, desteklenmeyen ve fazla uzun dosyaları reddeder", async () => {
    for (const f of [file("a.txt", " "), file("a.md", "a\0b"), file("a.pdf", "metin"), file("a.txt", "a".repeat(120001))]) {
      await expect(readStyleFile(f)).rejects.toThrow();
    }
  });
  it("örnek olmadığında mevcut istemi korur, kapalı örneği göndermez", () => {
    expect(buildStyleSystemPrompt("temel")).toBe("temel");
    expect(buildStyleSystemPrompt("temel", [{ ...ref, enabled: false }])).toBe("temel");
  });
  it("uzun dosyalar arasında bütçeyi paylaşır ve baş, orta, son kısımları alır", () => {
    const text = "BAŞ" + "a".repeat(30000) + "ORTA" + "b".repeat(30000) + "SON";
    const prompt = buildStyleSystemPrompt("temel", [ref, { ...ref, id: "2", content: text }]);
    expect(prompt).toContain("BAŞ");
    expect(prompt).toContain("ORTA");
    expect(prompt).toContain("SON");
    expect(prompt.length).toBeLessThan(STYLE_CONTEXT_CHARS + 4000);
    expect(prompt).toContain("Özetleme, kısaltma veya genişletme");
  });
  it("her parçada aynı stil istemini kullanır ve kaynak metni korur", async () => {
    const requests: { system: string; user: string }[] = [];
    await processTranscript("[00:01] İlk cümle.\n[00:02] İkinci cümle.", { ...DEFAULT_SETTINGS, chunkChars: 20, styleReferences: [ref] }, () => {}, () => {}, {
      deps: { chat: (args) => {
        requests.push(args);
        return { done: Promise.resolve("### [KONU: Test]\nMetin."), cancel: () => {} };
      } },
    }).promise;
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((r) => r.system === requests[0].system && r.system.includes(ref.content))).toBe(true);
    expect(requests[0].user).toContain("[00:01] İlk cümle.");
  });
});

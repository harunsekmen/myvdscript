import { describe, expect, it } from "vitest";
import { buildSynthesisPrompt, digestKey, insertableText, parseSynthesis, validateCitations } from "./synthesis";
import type { Source, Synthesis } from "./types";

const source: Source = {
  id: "a", title: "Kaynak A", url: "", createdAt: 0,
  transcriptRaw: "[00:27] İlk gerçek ifade\n[01:08] İkinci gerçek ifade",
  segments: [], insights: [],
};

const run: Synthesis = {
  id: "test", title: "", createdAt: 0, status: "partial",
  provider: "codex", model: "model", effort: "low", tone: "Analitik", prompt: "Açı",
  targetWords: 1200, sourceIds: ["a", "b", "c"], sections: [], citations: [], digests: [],
};

describe("kaynak sentezi", () => {
  it("validates three source mappings, normalizes nearby times and drops invented anchors", () => {
    const b = { ...source, id: "b", transcriptRaw: "", segments: [{ id: "s", title: "B", text: "Çeviri", marks: [{ para: 0, start: 0, t: 35 }] }] };
    const c = { ...source, id: "c", transcriptRaw: "[04:59] Son kaynak" };
    const sections = parseSynthesis("## İlk bölüm\nBirinci [K1 00:30]. Son [K3 05:00].\n\n## İkinci bölüm\nİkinci [K2 0:33]. Hatalı [K1 08:50] [K4 00:27].");
    expect(validateCitations(sections, [source, b, c]).map(({ sourceId, sectionIndex, t }) => [sourceId, sectionIndex, t])).toEqual([
      ["a", 0, 27], ["c", 0, 299], ["b", 1, 35],
    ]);
    expect(insertableText(sections)).toBe("## İlk bölüm\n\nBirinci. Son.\n\n## İkinci bölüm\n\nİkinci. Hatalı.");
  });

  it("invalidates the digest when input, date or generation settings change", () => {
    const key = digestKey(source, source.transcriptRaw, run);
    expect(digestKey(source, source.transcriptRaw, { ...run, prompt: "Yeni açı" })).toBe(key);
    expect(digestKey({ ...source, processedAt: 10 }, source.transcriptRaw, run)).not.toBe(key);
    expect(digestKey(source, "Yeni kaynak", run)).not.toBe(key);
    expect(digestKey(source, source.transcriptRaw, { ...run, effort: "high" })).not.toBe(key);
    expect(digestKey(source, source.transcriptRaw, { ...run, model: "başka" })).not.toBe(key);
  });

  it("caps the complete prompt and retains the ordered source map", () => {
    expect(buildSynthesisPrompt([{ title: "A", text: "Metin" }, { title: "B", text: "Özet" }], run)).toContain("K2 — B\nÖzet");
    expect(() => buildSynthesisPrompt([{ title: "A", text: "a".repeat(24_000) }], run)).toThrow("24.000");
  });
});

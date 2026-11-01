import { describe, expect, it } from "vitest";
import { alignSentences, makeStylePairs, parseCues, toSentences } from "./styleAlign";

const SRT_EN = `1
00:00:00,000 --> 00:00:03,000
Rust is becoming the default choice for

2
00:00:03,000 --> 00:00:06,000
Rust is becoming the default choice for AI tooling.

3
00:00:06,000 --> 00:00:09,000
Teams keep rewriting their runtimes in it.
`;

const SRT_TR = `1
00:00:00,500 --> 00:00:05,000
Yapay zeka araçları için Rust giderek varsayılan seçim oluyor.

2
00:00:05,000 --> 00:00:09,500
Ekipler çalışma zamanlarını sürekli bu dille yeniden yazıyor.
`;

describe("altyazı hizalama", () => {
  it("otomatik altyazıdaki tekrarlı satırları ayıklar", () => {
    const cues = parseCues(SRT_EN);
    expect(cues.map((c) => c.text)).toEqual([
      "Rust is becoming the default choice for AI tooling.",
      "Teams keep rewriting their runtimes in it.",
    ]);
    expect(cues[0]).toEqual({ start: 0, end: 6, text: "Rust is becoming the default choice for AI tooling." });
  });

  it("VTT zaman damgalarını ve etiketlerini okur", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500 align:start\n<c>Merhaba</c> dünya.\n";
    expect(parseCues(vtt)).toEqual([{ start: 1, end: 2.5, text: "Merhaba dünya." }]);
  });

  it("kueleri noktalama işaretine göre cümlelere birleştirir", () => {
    const sents = toSentences(parseCues(SRT_EN));
    expect(sents.map((s) => s.text)).toEqual([
      "Rust is becoming the default choice for AI tooling.",
      "Teams keep rewriting their runtimes in it.",
    ]);
  });

  it("çeviri cümlelerini zamanca örtüşen kaynak cümlelerle eşleştirir", () => {
    const pairs = makeStylePairs(SRT_EN, SRT_TR);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].target).toBe("Yapay zeka araçları için Rust giderek varsayılan seçim oluyor.");
    expect(pairs[0].source).toContain("Rust is becoming the default choice for AI tooling.");
    expect(pairs[1].source).toBe("Teams keep rewriting their runtimes in it.");
  });

  it("çok kısa cümle çiftlerini atar", () => {
    const pairs = alignSentences(
      [{ start: 0, end: 1, text: "Evet." }],
      [{ start: 0, end: 1, text: "Tamam." }],
    );
    expect(pairs).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { baseName, buildCues, srtTime, toSrt, toVtt, vttTime, wrapCue } from "./subtitleExport";
import type { TimedItem } from "./types";

let n = 0;
const w = (t: string, s: number, e: number): TimedItem => ({ k: "w", id: "x" + n++, w: t, s, e });
const br: TimedItem = { k: "br" };

describe("zaman biçimi", () => {
  it("srt virgül, vtt nokta", () => {
    expect(srtTime(1.234)).toBe("00:00:01,234");
    expect(vttTime(3725.0004)).toBe("01:02:05.000");
    expect(srtTime(59.9996)).toBe("00:01:00,000");
  });
});

describe("wrapCue", () => {
  it("kısa metin tek satır, uzun metin dengeli iki satır", () => {
    expect(wrapCue(["a", "b"], 42)).toBe("a b");
    const words = "Bu çok uzun bir cümle ve iki satıra bölünmesi gerekiyor çünkü sığmıyor".split(" ");
    const out = wrapCue(words, 42).split("\n");
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.length <= 42)).toBe(true);
  });
});

describe("buildCues", () => {
  it("satır sonunda böler, notları yok sayar", () => {
    const cues = buildCues([w("Merhaba", 0, 0.5), w("dünya", 0.6, 1.2), { k: "note", id: "n", text: "x" }, br, w("Devam", 1.3, 2.4)]);
    expect(cues.map((c) => c.text)).toEqual(["Merhaba dünya", "Devam"]);
    expect(cues[0].end).toBeCloseTo(1.2);
  });
  it("uzun duraklamada böler", () => {
    expect(buildCues([w("a", 0, 1), w("b", 5, 6)])).toHaveLength(2);
  });
  it("6.5 sn sınırını aşınca böler", () => {
    const items: TimedItem[] = [];
    for (let i = 0; i < 20; i++) items.push(w("kelime", i * 0.5, i * 0.5 + 0.4));
    const cues = buildCues(items);
    expect(cues.length).toBeGreaterThan(1);
    for (const c of cues) expect(c.end - c.start).toBeLessThanOrEqual(7);
  });
  it("karakter sınırını aşınca en çok 2 satır", () => {
    const items: TimedItem[] = [];
    for (let i = 0; i < 30; i++) items.push(w("kelime", i * 0.1, i * 0.1 + 0.09));
    for (const c of buildCues(items)) {
      const lines = c.text.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.every((l) => l.length <= 42)).toBe(true);
    }
  });
  it("en kısa süre sağlanır, çakışma olmaz", () => {
    const cues = buildCues([w("a", 0, 0.1), br, w("b", 0.3, 0.4), br, w("c", 3, 3.1)]);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    expect(cues[2].end - cues[2].start).toBeCloseTo(0.8);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
  });
});

describe("toSrt / toVtt", () => {
  const cues = [
    { start: 1.234, end: 2.5, text: "Merhaba\ndünya" },
    { start: 3, end: 4, text: "a < b" },
  ];
  it("SRT", () => {
    expect(toSrt(cues)).toBe("1\n00:00:01,234 --> 00:00:02,500\nMerhaba\ndünya\n\n2\n00:00:03,000 --> 00:00:04,000\na < b\n");
  });
  it("VTT başlıklı, nokta ayraçlı, kaçışlı", () => {
    const v = toVtt(cues);
    expect(v.startsWith("WEBVTT\n\n00:00:01.234 --> 00:00:02.500")).toBe(true);
    expect(v).toContain("a &lt; b");
  });
});

describe("baseName", () => {
  it("uzantı ve yolu atar", () => {
    expect(baseName("C:\\x\\ses kaydı.final.mp3")).toBe("ses kaydı.final");
    expect(baseName("a.mp4")).toBe("a");
  });
});

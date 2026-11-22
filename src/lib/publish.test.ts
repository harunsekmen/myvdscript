import { describe, expect, it } from "vitest";
import { chapterText, estimateChapters, estimateCues, parseChapterText, publishRequest, readPublishReply, scriptSrt } from "./publish";
import type { JSONContent } from "@tiptap/core";

describe("yayın çıktısı", () => {
  it("estimates headings without counting writer notes and parses editable chapter times", () => {
    const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
    const h = (text: string): JSONContent => ({ ...p(text), type: "heading" });
    const doc = { type: "doc", content: [p("bir ".repeat(27)), { type: "paragraph", content: [{ type: "text", text: "not ".repeat(30), marks: [{ type: "scriptNote" }] }] }, h("Birinci"), p("iki ".repeat(54)), h("İkinci")] };
    const chapters = estimateChapters(doc, 160);
    expect(chapters).toEqual([{ title: "Giriş", startSec: 0 }, { title: "Birinci", startSec: 10 }, { title: "İkinci", startSec: 31 }]);
    expect(parseChapterText(chapterText(chapters))).toEqual(chapters);
  });

  it("exports bounded and contiguous estimated cues even for a long word", () => {
    const text = ("Türkçe bir konuşma ve yeni satırlar. " + "ş".repeat(120) + " ").repeat(15);
    const cues = estimateCues(text, 80);
    expect(cues.length).toBeGreaterThan(10);
    for (const [index, cue] of cues.entries()) {
      expect(cue.start).toBe(cues[index - 1]?.end ?? 0);
      expect(cue.end - cue.start).toBeGreaterThanOrEqual(1.2 - 1e-9);
      expect(cue.end - cue.start).toBeLessThanOrEqual(6 + 1e-9);
      expect(cue.text.split("\n").length).toBeLessThanOrEqual(2);
      expect(Math.max(...cue.text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(42);
    }
    expect(scriptSrt(text, 160).srt).toContain("00:00:00,000 -->");
  });

  it("uses actual timed words and enforces structured metadata and Shorts hooks", () => {
    const output = scriptSrt("Senaryo", 160, { source: "demo", lang: "tr", items: [{ k: "w", id: "w", s: 3, e: 4, w: "Kayıt" }] });
    expect(output).toEqual({ estimated: false, srt: "1\n00:00:03,000 --> 00:00:04,000\nKayıt\n" });
    expect(publishRequest("all", "Senaryo", 160).schema.required).toEqual(["titles", "description", "tags", "pinnedComment"]);
    expect(publishRequest("shorts", "Seçim", 160).user).toContain("120–160 kelime");
    expect(readPublishReply(JSON.stringify({ shorts: [{ title: "Başlık", text: "Metin", hooks: ["Bir", "İki", "Üç"] }] }), "shorts").shorts).toHaveLength(1);
    expect(() => readPublishReply('{"titles":["Bir"]}', "titles")).toThrow("5 benzersiz başlık");
  });
});

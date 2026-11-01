import { describe, expect, it } from "vitest";
import { audioRange, markTimeAt, parseSegments, paragraphsOf, segmentsToMarkdown, sentenceAtTime, splitParas } from "./segmentParser";
import { buildChunkMessage } from "./prompts";

describe("zaman işaretleri", () => {
  it("işaretleri temiz metinden ayırır ve paragraf konumlarını verir", () => {
    const [s] = parseSegments("### [KONU: A]\n[00:05] Merhaba dünya. [00:09] İkinci cümle.\n\n[00:20] Yeni paragraf.");
    expect(s.text).toBe("Merhaba dünya. İkinci cümle.\n\nYeni paragraf.");
    expect(s.marks).toEqual([
      { para: 0, start: 0, t: 5 },
      { para: 0, start: 15, t: 9 },
      { para: 1, start: 0, t: 20 },
    ]);
    expect(paragraphsOf(s.text)).toEqual(splitParas(s.text).map((p) => p.text));
  });

  it("işaretsiz boş paragrafın işareti sonraki paragrafa taşınır", () => {
    const [s] = parseSegments("[00:01]\n\nBir.\n\nİki.");
    expect(s.marks).toEqual([{ para: 0, start: 0, t: 1 }]);
    expect(paragraphsOf(s.text)).toEqual(["Bir.", "İki."]);
  });

  it("işaret yoksa marks alanı yoktur", () => {
    const [s] = parseSegments("### [KONU: A]\nDüz metin.");
    expect(s.marks).toBeUndefined();
  });

  it("seçim aralığını cümle zamanlarına eşler", () => {
    const marks = [
      { para: 0, start: 0, t: 5 },
      { para: 0, start: 15, t: 9 },
      { para: 1, start: 0, t: 20 },
    ];
    // ikinci cümlenin içinden seçim → 9 sn'den başla, sonraki cümle (20 sn) başında bitir
    expect(audioRange(marks, { para: 0, start: 16, end: 20 })).toEqual({ from: 9, to: 20 });
    expect(audioRange(marks, { para: 0, start: 2, end: 10 })).toEqual({ from: 5, to: 9 });
    expect(audioRange(marks, { para: 1, start: 0, end: 4 })).toEqual({ from: 20, to: undefined });
    expect(audioRange(undefined, { para: 0, start: 0, end: 1 })).toBeNull();
  });

  it("segmentsToMarkdown işaretleri geri yazar ve tekrar ayrıştırılınca aynı kalır", () => {
    const segs = parseSegments("### [KONU: A]\n[00:05] Merhaba dünya. [00:09] İkinci cümle.\n\n[00:20] Yeni paragraf.");
    const md = segmentsToMarkdown(segs);
    expect(md).toContain("[00:09] İkinci");
    const back = parseSegments(md);
    expect(back[0].marks).toEqual(segs[0].marks);
    expect(back[0].text).toBe(segs[0].text);
  });

  it("zamanlı altyazı parçasına zaman kuralı eklenir, düz metne eklenmez", () => {
    expect(buildChunkMessage("[00:01] merhaba", null, 0, 1)).toContain("ZAMAN İŞARETLERİ");
    expect(buildChunkMessage("merhaba", null, 0, 1)).not.toContain("ZAMAN İŞARETLERİ");
  });

  it("çalan cümleyi ve seçili başlangıcın zamanını bulur", () => {
    const marks = [
      { para: 0, start: 0, t: 5 },
      { para: 0, start: 15, t: 9 },
      { para: 1, start: 0, t: 20 },
    ];
    const lens = [29, 16];
    expect(sentenceAtTime(marks, lens, 6)).toEqual({ para: 0, start: 0, end: 15 });
    expect(sentenceAtTime(marks, lens, 10)).toEqual({ para: 0, start: 15, end: 29 });
    expect(sentenceAtTime(marks, lens, 25)).toEqual({ para: 1, start: 0, end: 16 });
    expect(sentenceAtTime(marks, lens, 1)).toBeNull();
    expect(markTimeAt(marks, 0, 20)).toBe(9);
    expect(markTimeAt(marks, 1, 0)).toBe(20);
  });
});

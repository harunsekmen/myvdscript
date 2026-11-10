import { describe, expect, it } from "vitest";
import { buildChapterMessage, parseChapterTitles, sameTitles } from "./chapters";

describe("bölüm başlığı çevirisi", () => {
  it("mesajı numaralı kurar", () => {
    expect(buildChapterMessage(["Intro", "Setup"])).toBe("Bölüm başlıkları (2 adet):\n1. Intro\n2. Setup");
  });
  it("yanıtı ayıklar, sayı tutmazsa reddeder", () => {
    expect(parseChapterTitles('tamam {"titles":["Giriş"," Kurulum "]}', 2)).toEqual(["Giriş", "Kurulum"]);
    expect(parseChapterTitles('{"titles":["Giriş"]}', 2)).toBeNull();
    expect(parseChapterTitles('{"titles":["Giriş",""]}', 2)).toBeNull();
    expect(parseChapterTitles("bozuk", 1)).toBeNull();
  });
  it("aynı liste karşılaştırması", () => {
    expect(sameTitles(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTitles(["a"], ["a", "b"])).toBe(false);
    expect(sameTitles(undefined, [])).toBe(false);
  });
});

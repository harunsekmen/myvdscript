import { describe, expect, it } from "vitest";
import { resolveInsight } from "./insights";

const official = "https://support.google.com/youtube/answer/9884579?hl=tr";
const event = JSON.stringify({ type: "web_search", results: [{ title: "YouTube Help", url: official }] });
const answer = JSON.stringify({
  verdict: "supported", text: "İlk bölüm 00:00'dan başlar.",
  sources: [{ url: official }, { url: "https://example.com/guessed" }],
});

describe("canlı arama kanıtı", () => {
  it("yalnız arama sonuçlarında görülen URL’leri saklar", () => {
    expect(resolveInsight(answer, [event], "factcheck")).toMatchObject({
      verdict: "supported", sources: [{ title: "YouTube Help", url: official }],
    });
  });

  it("araç kaynağı yoksa modelin hükmünü göstermez", () => {
    expect(resolveInsight(answer, [], "factcheck")).toMatchObject({
      verdict: "unverified", sources: [], text: "Bu iddia canlı web kaynaklarıyla doğrulanamadı.",
    });
  });
});

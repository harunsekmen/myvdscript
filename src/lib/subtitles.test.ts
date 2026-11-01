import { describe, expect, it } from "vitest";
import type { SubOption } from "./api";
import { defaultSubtitle, filterSubtitles } from "./subtitles";

const o = (lang: string, auto: boolean, name = lang): SubOption => ({ lang, name, auto });

describe("defaultSubtitle", () => {
  it("elle yazılmış İngilizceyi otomatik olanların önüne koyar", () => {
    const opts = [o("de", false), o("en", true), o("en", false), o("tr", true)];
    expect(defaultSubtitle(opts)?.lang).toBe("en");
    expect(defaultSubtitle(opts)?.auto).toBe(false);
  });

  it("elle İngilizce yoksa otomatik İngilizceyi seçer (TR otomatiğinden önce)", () => {
    const opts = [o("tr", false), o("tr", true), o("en", true)];
    expect(defaultSubtitle(opts)).toEqual(o("en", true));
  });

  it("en-US gibi varyantları exact en'den sonra seçer", () => {
    const opts = [o("en-US", false), o("en", true)];
    expect(defaultSubtitle(opts)).toEqual(o("en", true));
  });

  it("İngilizce yoksa ilk elle yazılmış seçeneği seçer", () => {
    expect(defaultSubtitle([o("tr", true), o("de", false), o("fr", false)])?.lang).toBe("de");
  });

  it("hiç seçenek yoksa undefined", () => {
    expect(defaultSubtitle([])).toBeUndefined();
  });
});

describe("filterSubtitles", () => {
  it("dil kodu ve ada göre süzer", () => {
    const opts = [o("en", false, "English"), o("tr", true, "Türkçe"), o("de", true, "Deutsch")];
    expect(filterSubtitles(opts, "tür").map((x) => x.lang)).toEqual(["tr"]);
    expect(filterSubtitles(opts, "EN").map((x) => x.lang)).toEqual(["en"]);
    expect(filterSubtitles(opts, "  ")).toHaveLength(3);
  });
});

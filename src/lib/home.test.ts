import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES } from "./settingsDefaults";
import {
  advanceStage,
  countByStage,
  filterSort,
  formatCount,
  formatDelta,
  formatDuration,
  formatViews,
  inferStage,
  projectStats,
  resolveStage,
  timeAgo,
  viewDelta,
} from "./home";
import type { ProjectMeta, VideoStat } from "./types";

const meta = (o: Partial<ProjectMeta>): ProjectMeta => ({
  id: "x",
  title: "T",
  url: "",
  createdAt: 1,
  updatedAt: 1,
  stage: "idea",
  checkDone: 0,
  checkTotal: 0,
  checklist: [],
  note: "",
  pinned: false,
  archived: false,
  sources: [],
  ...o,
});
const stat = (id: string, views: number | null, history: { t: number; views: number }[] = []): VideoStat => ({
  id,
  title: "V " + id,
  channel: "Kanal",
  views,
  likes: null,
  comments: null,
  duration: 0,
  uploadedAt: 0,
  fetchedAt: 0,
  history,
});

describe("biçimlendirme", () => {
  it("izlenme", () => {
    expect(formatViews(1_234_567)).toBe("1,2 Mn görüntüleme");
    expect(formatCount(1200)).toBe("1,2 B");
    expect(formatDelta(1200)).toBe("+1,2 B");
  });
  it("süre", () => {
    expect(formatDuration(61)).toBe("1:01");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(5)).toBe("0:05");
  });
  it("zaman", () => {
    const now = 1_700_000_000_000;
    expect(timeAgo(now - 3 * 365 * 86400_000, now)).toBe("3 yıl önce");
    expect(timeAgo(now - 5 * 86400_000, now)).toBe("5 gün önce");
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3 saat önce");
    expect(timeAgo(now - 5_000, now)).toBe("az önce");
  });
});

describe("izlenme farkı", () => {
  it("son iki ölçüm", () => {
    expect(viewDelta(stat("a", 10, [{ t: 1, views: 5 }, { t: 2, views: 10 }]))).toBe(5);
    expect(viewDelta(stat("a", 10, [{ t: 1, views: 10 }]))).toBeNull();
    expect(viewDelta(stat("a", 10, [{ t: 1, views: 10 }, { t: 2, views: 10 }]))).toBeNull();
    expect(viewDelta(undefined)).toBeNull();
  });
  it("çok videolu toplam", () => {
    const m = meta({
      sources: [
        { url: "https://youtu.be/abcdefghijk", title: "" },
        { url: "https://youtu.be/bcdefghijkl", title: "" },
        { url: "x", title: "" },
      ],
    });
    const ps = projectStats(m, { abcdefghijk: stat("abcdefghijk", 100), bcdefghijkl: stat("bcdefghijkl", 50) });
    expect(ps.videos).toHaveLength(3);
    expect(ps.totalViews).toBe(150);
    expect(projectStats(m, {}).totalViews).toBeNull();
  });
});

describe("aşama", () => {
  it("tahmin", () => {
    expect(inferStage({ sources: [] })).toBe("idea");
    expect(inferStage({ sources: [{ transcriptRaw: "x", segments: [] }] })).toBe("subs");
    expect(inferStage({ sources: [{ transcriptRaw: "x", segments: [{}] }] })).toBe("processed");
    expect(inferStage({ editorDoc: { type: "doc", content: [{ type: "paragraph" }] }, sources: [] })).toBe("idea");
    expect(
      inferStage({ editorDoc: { type: "doc", content: [{ type: "text", text: "a" }] }, sources: [{ segments: [{}] }] }),
    ).toBe("writing");
  });
  it("otomatik aşama yalnızca ileri taşır", () => {
    expect(advanceStage(DEFAULT_STAGES, "idea", "subs")).toBe("subs");
    expect(advanceStage(DEFAULT_STAGES, undefined, "subs")).toBe("subs");
    expect(advanceStage(DEFAULT_STAGES, "writing", "processed")).toBeNull();
    expect(advanceStage(DEFAULT_STAGES, "processed", "processed")).toBeNull();
    expect(advanceStage(DEFAULT_STAGES, "idea", "yok")).toBeNull();
  });
  it("bilinmeyen kimlik ilk aşamaya düşer", () => {
    expect(resolveStage(DEFAULT_STAGES, "yok").id).toBe("idea");
  });
});

describe("filtre ve sıralama", () => {
  const a = meta({ id: "a", title: "Uzay", updatedAt: 5, stage: "filmed", sources: [{ url: "https://youtu.be/abcdefghijk", title: "" }] });
  const b = meta({ id: "b", title: "Deniz", updatedAt: 9, stage: "idea", note: "mavi" });
  const c = meta({ id: "c", title: "Orman", updatedAt: 1, stage: "idea", pinned: true });
  const stats = { abcdefghijk: stat("abcdefghijk", 900) };
  const run = (f: Partial<{ query: string; stage: string | null; sort: any }>) =>
    filterSort([a, b, c], { query: "", stage: null, sort: "updated", ...f }, stats, DEFAULT_STAGES).map((m) => m.id);
  it("sabitlenen önce", () => expect(run({})).toEqual(["c", "b", "a"]));
  it("arama başlık, not ve kanal", () => {
    expect(run({ query: "uz" })).toEqual(["a"]);
    expect(run({ query: "MAVİ" })).toEqual(["b"]);
    expect(run({ query: "kanal" })).toEqual(["a"]);
  });
  it("aşama süzgeci", () => expect(run({ stage: "idea" })).toEqual(["c", "b"]));
  it("izlenmeye göre", () => expect(run({ sort: "views" })).toEqual(["c", "a", "b"]));
  it("sayım arşivi saymaz", () => {
    expect(countByStage([a, b, meta({ id: "z", archived: true })], DEFAULT_STAGES)).toEqual({ filmed: 1, idea: 1 });
  });
});

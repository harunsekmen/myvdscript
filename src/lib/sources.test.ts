import { describe, expect, it } from "vitest";
import { upsertMeta } from "./projectList";
import {
  activeSource,
  addSource,
  applyProcessed,
  HISTORY_MAX,
  makeSource,
  migrateProject,
  patchSource,
  removeSource,
  restoreHistory,
} from "./sources";
import type { Project, Segment } from "./types";

const seg = (t: string): Segment => ({ id: t, title: t, text: t });
const legacy = {
  id: "p1",
  title: "Eski proje",
  url: "https://youtu.be/abc",
  createdAt: 5,
  updatedAt: 6,
  transcriptRaw: "[00:01] hi",
  segments: [seg("a")],
  insights: [{ id: "i", segmentId: "a", para: 0, start: 0, end: 1, quote: "a", results: [] }],
  editorDoc: null,
  imageMeta: {},
};

describe("proje geçişi (eski -> kaynaklı)", () => {
  it("üst düzey alanlar tek kaynağa taşınır", () => {
    const p = migrateProject(legacy);
    expect(p.sources).toHaveLength(1);
    const s = p.sources[0];
    expect(s.url).toBe("https://youtu.be/abc");
    expect(s.transcriptRaw).toBe("[00:01] hi");
    expect(s.segments).toHaveLength(1);
    expect(s.insights).toHaveLength(1);
    expect(s.title).toBe("Eski proje");
    expect(p.activeSourceId).toBe(s.id);
    expect(p.url).toBe("https://youtu.be/abc");
    expect("segments" in p).toBe(false);
    expect("transcriptRaw" in p).toBe(false);
  });

  it("boş proje bir boş kaynak alır, geçici başlık kaynak başlığı olmaz", () => {
    const p = migrateProject({ ...legacy, title: "Yeni proje", url: "", transcriptRaw: undefined, segments: undefined, insights: undefined });
    expect(p.sources).toHaveLength(1);
    expect(p.sources[0].title).toBe("");
    expect(p.sources[0].segments).toEqual([]);
  });

  it("yeni biçim olduğu gibi kalır, geçersiz etkin kaynak ilkine düşer, url ilk kaynağa eşitlenir", () => {
    const a = makeSource("https://a", "A", 1, "a");
    const b = makeSource("https://b", "B", 2, "b");
    const p = migrateProject({ id: "p", title: "t", url: "x", createdAt: 1, updatedAt: 1, sources: [a, b], activeSourceId: "zzz", editorDoc: null, imageMeta: {} });
    expect(p.sources.map((s) => s.id)).toEqual(["a", "b"]);
    expect(p.activeSourceId).toBe("a");
    expect(p.url).toBe("https://a");
    expect(migrateProject(p)).toEqual(p);
  });
});

describe("kaynak işlemleri", () => {
  const base = (): Project => migrateProject(legacy);

  it("ekle / etkinleştir / sil", () => {
    let p = base();
    const first = p.sources[0].id;
    const b = makeSource("https://b", "B", 1, "b");
    p = addSource(p, b);
    expect(p.activeSourceId).toBe("b");
    expect(p.url).toBe("https://youtu.be/abc");
    p = removeSource(p, "b");
    expect(p.activeSourceId).toBe(first);
    p = removeSource(p, first, 9);
    expect(p.sources).toHaveLength(1);
    expect(p.sources[0].segments).toEqual([]);
    expect(activeSource(p).id).toBe(p.activeSourceId);
  });

  it("ilk kaynak değişince üst düzey url güncellenir; olmayan kaynak yok sayılır", () => {
    let p = base();
    p = patchSource(p, p.sources[0].id, (s) => ({ ...s, url: "https://yeni" }));
    expect(p.url).toBe("https://yeni");
    expect(patchSource(p, "yok", (s) => ({ ...s, url: "x" }))).toBe(p);
  });
});

describe("işleme geçmişi", () => {
  it("önceki sürüm geçmişe girer, açıklamalar sıfırlanır, en çok 3 tutulur", () => {
    let s = migrateProject(legacy).sources[0];
    for (let i = 0; i < 5; i++) s = applyProcessed(s, [seg("v" + i)], "etiket" + i, 100 + i);
    expect(s.segments[0].id).toBe("v4");
    expect(s.insights).toEqual([]);
    expect(s.history).toHaveLength(HISTORY_MAX);
    expect(s.history!.map((h) => h.segments[0].id)).toEqual(["v3", "v2", "v1"]);
    expect(s.history![0].label).toBe("etiket3");
    expect(s.history![0].createdAt).toBe(103);
  });

  it("boş kaynağın ilk işlemesi geçmiş oluşturmaz; devam ettirme geçmişe eklemez", () => {
    let s = makeSource("u", "t", 1, "x");
    s = applyProcessed(s, [seg("a")], "ilk", 2);
    expect(s.history ?? []).toHaveLength(0);
    s = applyProcessed(s, [seg("b")], "ikinci", 3);
    expect(s.history).toHaveLength(1);
    s = applyProcessed(s, [seg("c")], "devam", 4, true);
    expect(s.history).toHaveLength(1);
    expect(s.segments[0].id).toBe("c");
  });

  it("geri yükleme: mevcut sürüm ile geçmiştekinin yeri değişir", () => {
    let s = makeSource("u", "t", 1, "x");
    s = applyProcessed(s, [seg("a")], "A", 10);
    s = applyProcessed(s, [seg("b")], "B", 20);
    s = restoreHistory(s, 0);
    expect(s.segments[0].id).toBe("a");
    expect(s.procLabel).toBe("A");
    expect(s.history).toHaveLength(1);
    expect(s.history![0].segments[0].id).toBe("b");
    expect(s.history![0].label).toBe("B");
    s = restoreHistory(s, 0);
    expect(s.segments[0].id).toBe("b");
    expect(restoreHistory(s, 7)).toBe(s);
  });
});

describe("proje listesi güncelleme", () => {
  it("kaydedilen proje yerinde güncellenir ve en üste çıkar", () => {
    const list = [
      { id: "a", title: "A", url: "", createdAt: 1, updatedAt: 50 },
      { id: "b", title: "B", url: "", createdAt: 1, updatedAt: 40 },
    ];
    const p = { ...migrateProject(legacy), id: "b", title: "B2" };
    const next = upsertMeta(list, p, 99);
    expect(next.map((m) => m.id)).toEqual(["b", "a"]);
    expect(next[0].title).toBe("B2");
    expect(next[0].updatedAt).toBe(99);
    expect(upsertMeta([], p, 1)).toEqual([]);
  });
});

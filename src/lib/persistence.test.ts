import { describe, expect, it } from "vitest";
import { withSchema } from "../hooks/useProjectStore";
import { disfluentWords } from "./disfluency";
import { makeSource } from "./sources";
import type { Project } from "./types";

/** Kaydet → kapat → aç: proje diske JSON olarak yazılır ve açılışta withSchema'dan geçer. */
const reopen = (p: Project) => withSchema(JSON.parse(JSON.stringify(p)));

describe("kaydedip yeniden açınca korunanlar", () => {
  const src = {
    ...makeSource("https://youtu.be/x", "Video", 1, "s1"),
    segments: [{ id: "g1", title: "Giriş", text: "Merhaba." }],
    chat: [
      { id: "c1", role: "user" as const, text: "Bu ne?", quote: "Merhaba", createdAt: 2 },
      { id: "c2", role: "assistant" as const, text: "Selamlama.", model: "m", createdAt: 3 },
    ],
  };
  const project: Project = {
    id: "p1",
    title: "Proje",
    url: "https://youtu.be/x",
    createdAt: 1,
    updatedAt: 1,
    sources: [src],
    activeSourceId: "s1",
    editorDoc: null,
    imageMeta: {},
    timed: {
      source: "a.mp4",
      lang: "tr",
      items: [
        { k: "w", id: "w1", w: "ıı", s: 0, e: 0.3 },
        { k: "w", id: "w2", w: "yani", s: 0.4, e: 0.7 },
        { k: "w", id: "w3", w: "harika", s: 0.8, e: 1.2 },
      ],
      disfluent: { w2: "filler", w3: "manual" },
      keepWords: ["w1"],
    },
  };

  it("AI sohbeti kaynakla birlikte korunur", () => {
    expect(reopen(project).sources[0].chat).toEqual(src.chat);
  });

  it("gereksiz kelime işaretleri ve 'gerekli' istisnaları korunur", () => {
    const t = reopen(project).timed!;
    expect(t.disfluent).toEqual({ w2: "filler", w3: "manual" });
    expect(t.keepWords).toEqual(["w1"]);
    expect([...disfluentWords(t).keys()].sort()).toEqual(["w2", "w3"]);
  });
});

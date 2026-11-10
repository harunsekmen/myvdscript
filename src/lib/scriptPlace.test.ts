import { describe, expect, it } from "vitest";
import { buildTimed, exportTimed } from "./timed";
import { alignWords, applyMoves, buildPlaceRequest, fold, groupApprox, parsePlaceReply, placeScriptItems, scriptTokens } from "./scriptPlace";
import type { TimedDoc, TimedItem } from "./types";

const P = (...content: any[]) => ({ type: "paragraph", content });
const T = (text: string) => ({ type: "text", text });
const IMG = (path: string, name = path) => ({ type: "imageChip", attrs: { path, name } });
const DOC = (...content: any[]) => ({ type: "doc", content });

/** Kelimeleri 0.5 sn aralıkla zamanlı belgeye çevirir. */
const spoken = (text: string): TimedDoc =>
  buildTimed(
    text.split(/\s+/).filter(Boolean).map((w, i) => ({ word: w, start: i * 0.5, end: i * 0.5 + 0.4 })),
    "kayit.mp3",
    "tr",
  );

/** Resimlerin hangi kelimenin önünde (yoksa "son") durduğu. */
const where = (items: TimedItem[]) => {
  const out: Record<string, string> = {};
  items.forEach((it, i) => {
    if (it.k !== "img") return;
    const next = items.slice(i + 1).find((x) => x.k === "w");
    out[it.path] = next && next.k === "w" ? next.w : "son";
  });
  return out;
};

describe("fold", () => {
  it("Türkçe küçük harf, aksansız, noktalamasız", () => {
    expect(fold("İstanbul'da,")).toBe("istanbulda");
    expect(fold("IŞIK")).toBe("isik");
    expect(fold("Çöğüş.")).toBe("cogus");
    expect(fold("—")).toBe("");
  });
});

describe("scriptTokens", () => {
  it("resimlerin kelime dizisindeki yerini çıkarır, başlık/listeleri de gezer", () => {
    const doc = DOC(
      { type: "heading", attrs: { level: 2 }, content: [T("Giriş")] },
      P(T("Merhaba dostlar."), IMG("a.png")),
      { type: "bulletList", content: [{ type: "listItem", content: [P(IMG("b.png"), T("ilk madde"))] }] },
    );
    const t = scriptTokens(doc, { "b.png": { name: "Grafik", note: "" } });
    expect(t.words).toEqual(["Giriş", "Merhaba", "dostlar.", "ilk", "madde"]);
    expect(t.atts).toEqual([
      { kind: "img", pos: 3, path: "a.png", name: "a.png", tail: true },
      { kind: "img", pos: 3, path: "b.png", name: "Grafik" },
    ]);
  });
});

describe("alignWords", () => {
  it("dolgu ve tekrarları atlayarak eşleştirir, ekli kelimeleri yakın sayar", () => {
    const m = alignWords(["bugün", "videoda", "yapay", "zekayı", "konuşacağız"], ["ıı", "bugün", "şey", "videodaki", "yapay", "zekayı", "konuşacağız"]);
    expect(Array.from(m)).toEqual([1, 3, 4, 5, 6]);
  });

  it("tekrar edilen cümlede son söyleyişi seçer", () => {
    const m = alignWords(["kedi", "çok", "güzel", "bir", "hayvan"], ["kedi", "çok", "kedi", "çok", "güzel", "bir", "hayvan"]);
    expect(m[0]).toBe(2);
    expect(m[1]).toBe(3);
  });

  it("senaryonun yalnızca bir kısmı okunduysa kalanı eşleşmez", () => {
    const m = alignWords(["bir", "iki", "üç", "dört", "beş", "altı"], ["bir", "iki", "üç"]);
    expect(Array.from(m)).toEqual([0, 1, 2, -1, -1, -1]);
  });
});

describe("placeScriptImages", () => {
  const script = DOC(
    P(T("Bugün sizlere yapay zekanın tarihini anlatacağım.")),
    P(IMG("turing.png"), T("Her şey Alan Turing ile başladı ve makineler düşünebilir mi diye sordu.")),
    P(T("Sonra derin öğrenme geldi."), IMG("grafik.png")),
    P(T("Bugün ise dil modelleri her yerde.")),
  );

  it("resmi, senaryoda kendisinden sonra gelen cümlenin söylendiği yere koyar", () => {
    const doc = spoken(
      "evet merhaba bugün sizlere yapay zekanın tarihini anlatacağım ıı her şey alan turing ile başladı ve makineler düşünebilir mi diye sordu sonra derin öğrenme geldi şey bugün ise dil modelleri her yerde",
    );
    const r = placeScriptItems(doc, script);
    expect(r.images).toBe(2);
    expect(r.approx).toEqual([]);
    expect(where(r.doc.items)).toEqual({ "turing.png": "her", "grafik.png": "şey" });
    // grafik.png, "geldi" kelimesinin arkasına bağlıdır (dolgu "şey"den önce)
    const gi = r.doc.items.findIndex((i) => i.k === "img" && i.path === "grafik.png");
    const prev = r.doc.items[gi - 1];
    expect(prev.k === "w" && prev.w).toBe("geldi");
    const img = r.doc.items[gi];
    expect(img.k === "img" && img.from).toBe("script");
  });

  it("yeniden çalıştırınca eski senaryo resimlerini kaldırır, elle eklenenlere dokunmaz", () => {
    const doc = spoken("bugün sizlere yapay zekanın tarihini anlatacağım her şey alan turing ile başladı");
    doc.items.splice(2, 0, { k: "img", id: "m", path: "elle.png", name: "elle" });
    const once = placeScriptItems(doc, script).doc;
    const twice = placeScriptItems(once, script).doc;
    const imgs = twice.items.filter((i) => i.k === "img").map((i) => (i.k === "img" ? i.path : ""));
    expect(imgs.sort()).toEqual(["elle.png", "grafik.png", "turing.png"]);
  });

  it("konuşma senaryodan saparsa resmi yaklaşık işaretler", () => {
    const s = DOC(P(T("ilk cümle burada bitiyor tamam")), P(IMG("x.png"), T("tamamen başka şeyler yazdım ama hiç okumadım")));
    const doc = spoken("ilk cümle burada bitiyor tamam sonra aklıma gelenleri anlattım uzun uzun durmadan");
    const r = placeScriptItems(doc, s);
    expect(r.images).toBe(1);
    // önceki cümle eşleştiği için arkasına kesin konur
    expect(r.approx).toEqual([]);
    expect(where(r.doc.items)["x.png"]).toBe("sonra");

    const r2 = placeScriptItems(spoken("hiç alakası olmayan bambaşka bir konuşma yaptım bugün"), s);
    expect(r2.approx.length).toBe(1);
    const img = r2.doc.items.find((i) => i.k === "img");
    expect(img?.k === "img" && img.approx).toBe(true);
  });

  it("resim yoksa ya da kelime yoksa belgeye dokunmaz", () => {
    const doc = spoken("merhaba dünya");
    expect(placeScriptItems(doc, DOC(P(T("merhaba dünya")))).images).toBe(0);
    expect(placeScriptItems({ source: "x", lang: "tr", items: [] }, script).images).toBe(0);
  });

  it("dışa aktarmada resim zamanıyla görünür", () => {
    const doc = spoken("bugün sizlere yapay zekanın tarihini anlatacağım her şey alan turing ile başladı");
    const r = placeScriptItems(doc, script);
    const out = exportTimed(r.doc, { "turing.png": { name: "Turing", note: "Turing'in fotoğrafı" } }, "markdown");
    expect(out).toContain("[RESİM @00:03.00]: turing.png (turing.png)");
    expect(out).toContain("[RESİM NOTU]: Turing'in fotoğrafı");
  });
});

describe("AI ile yerleştirme", () => {
  it("istek senaryo bağlamını, resim notunu ve numaralı kelimeleri içerir", () => {
    const s = DOC(P(T("önce bu")), P(IMG("x.png", "Harita"), T("sonra şu")));
    const doc = spoken("alakasız bir konuşma");
    const r = placeScriptItems(doc, s);
    const words = doc.items.filter((i) => i.k === "w").map((w, i) => ({ n: i + 1, w: w.k === "w" ? w.w : "", s: w.k === "w" ? w.s : 0 }));
    const [g] = groupApprox(r.approx, words.length);
    const req = buildPlaceRequest(g, scriptTokens(s), words, { "x.png": { name: "Harita", note: "Türkiye haritası" } });
    expect(req).toContain("önce bu ⟦RESİM 1⟧ sonra şu");
    expect(req).toContain("RESİM 1: Harita — resim notu: Türkiye haritası");
    expect(req).toContain("1 [00:00.0] alakasız");
  });

  it("yanıttan geçerli eşlemeleri ayıklar", () => {
    const m = parsePlaceReply('İşte: {"images":[{"k":1,"n":5},{"k":2,"n":99},{"k":7,"n":3}]}', 2, 1, 10);
    expect([...m]).toEqual([[1, 5]]);
    expect(parsePlaceReply("bozuk", 1, 1, 10).size).toBe(0);
  });

  it("taşımalar resmi kelimenin önüne alır ve yaklaşık işaretini kaldırır", () => {
    const doc = spoken("bir iki üç");
    const [a, b, c] = doc.items.filter((i) => i.k === "w").map((i) => (i.k === "w" ? i.id : ""));
    const items: TimedItem[] = [...doc.items, { k: "img", id: "r", path: "r.png", name: "r", from: "script", approx: true }];
    const moved = applyMoves(items, new Map([["r", b]]));
    expect(where(moved)).toEqual({ "r.png": "iki" });
    const img = moved.find((i) => i.k === "img");
    expect(img?.k === "img" && img.approx).toBeUndefined();
    expect(applyMoves(items, new Map([["r", "yok"]]))).toBe(items);
    void a;
    void c;
  });
});

describe("AI notları", () => {
  const N = (text: string) => ({ type: "text", text, marks: [{ type: "scriptNote" }] });

  it("not işaretli metin kelimelere katılmaz, bulunduğu yerde not olur; parçalar birleşir", () => {
    const doc = DOC(P(T("Merhaba dostlar. "), N("burada "), { type: "text", text: "logo", marks: [{ type: "scriptNote" }, { type: "bold" }] }, T(" bugün başlıyoruz")));
    const t = scriptTokens(doc);
    expect(t.words).toEqual(["Merhaba", "dostlar.", "bugün", "başlıyoruz"]);
    expect(t.atts).toEqual([{ kind: "note", pos: 2, text: "burada logo" }]);
  });

  it("not, ilgili yere zamanlı metinde not öğesi olarak konur; yeniden çalıştırınca çoğalmaz", () => {
    const script = DOC(
      P(T("Bugün sizlere yapay zekanın tarihini anlatacağım."), N("burada intro müziği kısılsın")),
      P(N("Bu bölümde arşiv görüntüleri kullan"), T("Her şey Alan Turing ile başladı ve makineler düşünebilir mi diye sordu.")),
    );
    const doc = spoken("bugün sizlere yapay zekanın tarihini anlatacağım ıı her şey alan turing ile başladı ve makineler düşünebilir mi diye sordu");
    const r = placeScriptItems(doc, script);
    expect(r.notes).toBe(2);
    expect(r.images).toBe(0);
    const items = r.doc.items;
    const notes = items.filter((i) => i.k === "note");
    expect(notes.map((n) => n.k === "note" && n.text)).toEqual(["burada intro müziği kısılsın", "Bu bölümde arşiv görüntüleri kullan"]);
    // paragraf sonundaki not önceki kelimeye ("anlatacağım") bağlanır, ikincisi "her"in önüne
    const i1 = items.findIndex((i) => i.k === "note");
    const prev = items[i1 - 1];
    expect(prev.k === "w" && prev.w).toBe("anlatacağım");
    const i2 = items.findIndex((i, k) => i.k === "note" && k > i1);
    const next = items[i2 + 1];
    expect(next.k === "w" && next.w).toBe("her");
    // elle eklenen nota dokunulmaz
    const withManual: TimedDoc = { ...r.doc, items: [{ k: "note", id: "m", text: "elle" }, ...r.doc.items] };
    const again = placeScriptItems(withManual, script).doc.items.filter((i) => i.k === "note");
    expect(again.length).toBe(3);
    const out = exportTimed(r.doc, {}, "markdown");
    expect(out).toContain("[NOT @00:03.00]: burada intro müziği kısılsın");
  });

  it("AI isteğinde not işareti ve metni yer alır", () => {
    const s = DOC(P(T("önce bu")), P(N("arka planda harita"), T("sonra şu")));
    const doc = spoken("alakasız bir konuşma");
    const r = placeScriptItems(doc, s);
    const words = doc.items.filter((i) => i.k === "w").map((w, i) => ({ n: i + 1, w: w.k === "w" ? w.w : "", s: w.k === "w" ? w.s : 0 }));
    const [g] = groupApprox(r.approx, words.length);
    const req = buildPlaceRequest(g, scriptTokens(s), words, {});
    expect(req).toContain("önce bu ⟦NOT 1⟧ sonra şu");
    expect(req).toContain("NOT 1: arka planda harita");
  });
});

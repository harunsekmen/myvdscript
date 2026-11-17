import { describe, expect, it } from "vitest";
import { editSegments, type TextEdit } from "./textEdit";
const options: TextEdit = { kind: "replace", find: "a.b", replacement: "$&", all: true, matchCase: true };
describe("hızlı metin düzeltme", () => {
  it("literal arar ve replacement karakterlerini olduğu gibi yazar", () => {
    const r = editSegments([{ id: "1", title: "Başlık", text: "a.b axb a.b" }], options);
    expect(r.segments[0].text).toBe("$& axb $&"); expect(r.count).toBe(2);
  });
  it("yalnızca ilk eşleşmeyi tüm bölümler arasında değiştirir", () => {
    const r = editSegments(["a.b a.b", "a.b"].map((text, i) => ({ id: String(i), title: "", text })), { ...options, all: false });
    expect(r.segments.map((s) => s.text)).toEqual(["$& a.b", "a.b"]);
  });
  it("Türkçe büyük küçük harfleri dönüştürür", () => {
    const seg = [{ id: "1", title: "Başlık", text: "ışık iz" }];
    expect(editSegments(seg, { ...options, kind: "upper" }).segments[0].text).toBe("IŞIK İZ");
    expect(editSegments([{ ...seg[0], text: "IŞIK İZ" }], { ...options, kind: "lower" }).segments[0].text).toBe("ışık iz");
  });
  it("değişen uzunluğa göre cümle zaman konumunu taşır", () => {
    const r = editSegments([{ id: "1", title: "", text: "a.b Son.", marks: [{ para: 0, start: 4, t: 10 }] }], { ...options, replacement: "uzun metin" });
    expect(r.segments[0].marks?.[0]).toEqual({ para: 0, start: 11, t: 10 });
  });
});

import { describe, expect, it } from "vitest";
import { exportDoc } from "./copyExport";

const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Giriş" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Önce " },
        { type: "text", text: "kalın", marks: [{ type: "bold" }] },
        { type: "imageChip", attrs: { path: "C:\\data\\images\\a.png", name: "a.png" } },
        { type: "text", text: "sonra devam" },
      ],
    },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "madde" }] }] }] },
  ],
};
const meta = { "C:\\data\\images\\a.png": { name: "a.png", note: "grafik\nburada" } };

describe("exportDoc", () => {
  it("markdown: resim yolu ve not dahil", () => {
    const md = exportDoc(doc, meta, "markdown");
    expect(md).toBe(
      "## Giriş\n\nÖnce **kalın**\n\n![a.png](C:\\data\\images\\a.png)\n> Resim notu: grafik burada\n\nsonra devam\n\n- madde\n",
    );
  });
  it("sadece metin: resim ve işaretler yok", () => {
    expect(exportDoc(doc, meta, "text")).toBe("Giriş\n\nÖnce kalın\n\nsonra devam\n\n- madde\n");
  });
  it("boşluklu yol <> içine alınır", () => {
    const d = { type: "doc", content: [{ type: "paragraph", content: [{ type: "imageChip", attrs: { path: "C:\\a b\\x.png", name: "x" } }] }] };
    expect(exportDoc(d, {}, "markdown")).toBe("![x](<C:\\a b\\x.png>)\n");
  });
  it("AI notu: markdown'da [NOT: …] olarak kalır, düz metinde atlanır", () => {
    const N = (text: string) => ({ type: "text", text, marks: [{ type: "scriptNote" }] });
    const d = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Merhaba " }, N("müzik gir"), { type: "text", text: " dostlar" }] }] };
    const md = exportDoc(d, {}, "markdown");
    expect(md).toContain("Merhaba [NOT: müzik gir] dostlar\n");
    expect(md.startsWith("(Not:")).toBe(true);
    expect(exportDoc(d, {}, "text")).toBe("Merhaba dostlar\n");
  });
});

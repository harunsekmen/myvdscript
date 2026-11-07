import { Extension } from "@tiptap/core";

/**
 * Yedek: satır başına "# ", "- ", "1. " gibi markdown işareti yazılıp (ya da başka yolla düz metin
 * olarak girip) Enter'a basılırsa satır gerçek başlığa/listeye çevrilir.
 */
export const MarkdownEnter = Extension.create({
  name: "markdownEnter",
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const node = $from.parent;
        if (!empty || node.type.name !== "paragraph") return false;
        const m = /^(#{1,3}|[-*+]|\d+[.)])\s+(?=\S)/.exec(node.textContent);
        if (!m) return false;
        const start = $from.start();
        const chain = editor.chain().deleteRange({ from: start, to: start + m[0].length });
        const mark = m[1];
        if (mark[0] === "#") chain.setNode("heading", { level: mark.length });
        else if (/\d/.test(mark)) chain.toggleOrderedList();
        else chain.toggleBulletList();
        chain.run();
        return false; // ardından normal Enter: yeni satıra geçer
      },
    };
  },
});

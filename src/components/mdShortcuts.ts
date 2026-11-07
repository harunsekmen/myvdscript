import { Extension, InputRule, type Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";

const BLOCK = /^(#{1,6}|[-*+]|\d+[.)]|>)\s+\S/;
const RULE = /^([-*_])\1{2,}$/;
const FENCE = /^```([\w+-]*)$/;
const INLINE = /\*\*[^*\n]+\*\*|(^|\s)\*[^*\s][^*\n]*\*(\s|$)|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)/;

/**
 * Markdown yazımı için ek kurallar:
 * - `[yazı](adres)` yazılınca bağlantıya dönüşür.
 * - Satırda düz metin olarak kalmış markdown (başlık, liste, alıntı, ```, ---, **kalın**, `kod`, bağlantı…)
 *   Enter'a basınca gerçek biçime çevrilir. Böylece hangi yolla girilmiş olursa olsun görünür hale gelir.
 */
const PREFIX = /^(#{1,6}|[-*+]|\d+[.)]|>)[  ]/;

/**
 * İmleç, satır başındaki markdown işaretinin hemen ardındaysa ("# |", "- |", "1. |", "> |") işareti silip
 * paragrafı başlığa/listeye/alıntıya çevirir. Metnin hangi yolla girildiğinden (klavye, IME, yapıştırma)
 * bağımsız, doğrudan belgenin durumuna bakar.
 */
function convertPrefix(editor: Editor): boolean {
  if (editor.isDestroyed || (editor.view as any).composing) return false;
  const { $from, empty } = editor.state.selection;
  const node = $from.parent;
  if (!empty || node.type.name !== "paragraph") return false;
  const m = PREFIX.exec(node.textContent);
  if (!m || $from.parentOffset !== m[0].length) return false;
  const start = $from.start();
  const chain = () => editor.chain().deleteRange({ from: start, to: start + m[0].length });
  const mark = m[1];
  if (mark[0] === "#") return chain().setNode("heading", { level: mark.length }).run();
  if (mark === ">") return chain().toggleBlockquote().run();
  if (/\d/.test(mark)) return chain().toggleOrderedList().run();
  return chain().toggleBulletList().run();
}

export const MarkdownEnter = Extension.create({
  name: "markdownEnter",

  onUpdate() {
    const editor = this.editor;
    setTimeout(() => convertPrefix(editor), 0);
  },

  onCreate() {
    // Kompozisyon (IME) bitince de kontrol et.
    const editor = this.editor;
    editor.view.dom.addEventListener("compositionend", () => setTimeout(() => convertPrefix(editor), 0));
  },

  addInputRules() {
    const link = this.editor.schema.marks.link;
    if (!link) return [];
    return [
      new InputRule({
        find: /\[([^\]\n]+)\]\(([^)\s]+)\)$/,
        handler: ({ state, range, match }) => {
          state.tr
            .replaceWith(range.from, range.to, state.schema.text(match[1], [link.create({ href: match[2] })]))
            .removeStoredMark(link);
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      // Satır başında "#", "##", "-", "1." vb. yazıp boşluğa basınca biçime çevir. Metin girişi (input rule)
      // yolundan bağımsız, doğrudan tuş olayına bağlıdır; klavye/IME farklarında da çalışır.
      Space: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const node = $from.parent;
        if (!empty || node.type.name !== "paragraph" || $from.parentOffset !== node.content.size) return false;
        const text = node.textContent;
        const start = $from.start();
        const chain = () => editor.chain().deleteRange({ from: start, to: start + text.length });
        const h = /^(#{1,6})$/.exec(text);
        if (h) return chain().setNode("heading", { level: h[1].length }).run();
        if (/^[-*+]$/.test(text)) return chain().toggleBulletList().run();
        if (/^\d+[.)]$/.test(text)) return chain().toggleOrderedList().run();
        if (text === ">") return chain().toggleBlockquote().run();
        return false;
      },
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        const node = $from.parent;
        if (!empty || node.type.name !== "paragraph") return false;
        const text = node.textContent;
        const trimmed = text.trim();
        if (!trimmed || $from.parentOffset !== node.content.size) return false;

        // ``` (ve ```dil) → kod bloğu
        const fence = FENCE.exec(trimmed);
        if (fence) {
          editor.chain().command(({ tr, state }) => {
            const code = state.schema.nodes.codeBlock;
            if (!code) return false;
            const from = $from.before();
            tr.replaceWith(from, $from.after(), code.create(fence[1] ? { language: fence[1] } : null));
            tr.setSelection(Selection.near(tr.doc.resolve(from + 1)));
            return true;
          }).run();
          return true;
        }

        if (!BLOCK.test(text) && !RULE.test(trimmed) && !INLINE.test(text)) return false;
        const json = (editor as any).markdown?.parse?.(text);
        if (!json?.content?.length) return false;

        return editor
          .chain()
          .command(({ tr, state }) => {
            const { schema } = state;
            const nodes = json.content.map((n: any) => schema.nodeFromJSON(n));
            const last = nodes[nodes.length - 1];
            const list = last.type.name === "bulletList" || last.type.name === "orderedList";
            if (list) {
              const item = schema.nodes.listItem?.createAndFill();
              if (item) nodes[nodes.length - 1] = last.copy(last.content.append(Fragment.from(item)));
            } else {
              nodes.push(schema.nodes.paragraph.create());
            }
            const from = $from.before();
            tr.replaceWith(from, $from.after(), nodes);
            const end = from + nodes.reduce((n: number, x: any) => n + x.nodeSize, 0);
            tr.setSelection(Selection.near(tr.doc.resolve(end), -1));
            return true;
          })
          .run();
      },
    };
  },
});

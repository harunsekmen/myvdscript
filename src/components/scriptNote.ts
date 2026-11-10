import { Mark, mergeAttributes } from "@tiptap/core";
import { NOTE_MARK } from "../lib/scriptPlace";

/**
 * Senaryoda AI notu: seslendirilmeyecek, yalnızca AI'a bilgi olarak gidecek metin.
 * Seçili metne Ctrl+Shift+N ile ya da seçim balonundaki "Not" düğmesiyle uygulanır/kaldırılır.
 * Kapsayıcı değildir: notun sonunda yazmaya devam edince yazı normal metin olur.
 */
export const ScriptNote = Mark.create({
  name: NOTE_MARK,
  inclusive: false,
  excludes: "",

  parseHTML() {
    return [{ tag: "span[data-script-note]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-script-note": "", class: "script-note", title: "AI notu: seslendirilmez, AI'a not olarak gider" }), 0];
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-n": () => this.editor.commands.toggleMark(this.name),
    };
  },
});

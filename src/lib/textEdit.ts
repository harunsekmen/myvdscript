import type { Segment } from "./types";

export interface TextEdit { kind: "replace" | "upper" | "lower"; find: string; replacement: string; all: boolean; matchCase: boolean }

/** Literal arama; Türkçe harf dönüşümü ve zaman konumlarını birlikte günceller. */
export function editSegments(segments: Segment[], options: TextEdit): { segments: Segment[]; count: number } {
  let count = 0;
  const result = segments.map((segment) => {
    const edits: { start: number; end: number; text: string }[] = [];
    const text = segment.text;
    if (options.kind !== "replace") {
      for (let i = 0; i < text.length;) {
        const char = String.fromCodePoint(text.codePointAt(i)!);
        const value = options.kind === "upper" ? char.toLocaleUpperCase("tr-TR") : char.toLocaleLowerCase("tr-TR");
        if (value !== char) edits.push({ start: i, end: i + char.length, text: value });
        i += char.length;
      }
    } else if (options.find && (options.all || count === 0)) {
      const escaped = options.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, options.matchCase ? "gu" : "giu");
      for (const match of text.matchAll(re)) {
        edits.push({ start: match.index!, end: match.index! + match[0].length, text: options.replacement });
        if (!options.all) break;
      }
    }
    count += edits.length;
    if (!edits.length) return segment;
    const offset = (at: number) => {
      let delta = 0;
      for (const e of edits) {
        if (at <= e.start) break;
        if (at < e.end) return e.start + delta;
        delta += e.text.length - (e.end - e.start);
      }
      return at + delta;
    };
    let updated = text;
    for (const e of [...edits].reverse()) updated = updated.slice(0, e.start) + e.text + updated.slice(e.end);
    const paragraphs = text.split(/\n{2,}/);
    const starts: number[] = [];
    let at = 0;
    for (const para of paragraphs) { starts.push(at); at += para.length; const sep = text.slice(at).match(/^\n+/)?.[0] ?? ""; at += sep.length; }
    // Yeni satır içeren değişiklikler paragraf yapısını değiştirebilir; eski zamanları kullanma.
    const marks = /[\r\n]/.test(options.find + options.replacement) ? undefined : segment.marks?.map((m) => ({ ...m, start: offset((starts[m.para] ?? 0) + m.start) - offset(starts[m.para] ?? 0) }));
    return { ...segment, text: updated, marks };
  });
  return { segments: result, count };
}

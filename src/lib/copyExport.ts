import { NOTE_MARK } from "./scriptPlace";
import type { ImageMeta } from "./types";

export type CopyMode = "markdown" | "text";

interface PMNode {
  type: string;
  attrs?: Record<string, any>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string }[];
}

const isNote = (n: PMNode) => n.type === "text" && !!n.marks?.some((m) => m.type === NOTE_MARK);

const mdPath = (p: string) => (/[\s()]/.test(p) ? `<${p}>` : p);

function inlineText(n: PMNode, mode: CopyMode): string {
  if (n.type === "hardBreak") return "\n";
  if (n.type !== "text") return "";
  let t = n.text ?? "";
  if (mode === "markdown" && t.trim()) {
    for (const m of n.marks ?? []) {
      if (m.type === "bold") t = `**${t}**`;
      else if (m.type === "italic") t = `*${t}*`;
      else if (m.type === "code") t = `\`${t}\``;
    }
  }
  return t;
}

function imageBlock(n: PMNode, meta: Record<string, ImageMeta>, mode: CopyMode): string | null {
  if (mode === "text") return null;
  const path: string = n.attrs?.path ?? "";
  const name: string = meta[path]?.name || n.attrs?.name || "resim";
  const note = meta[path]?.note?.trim();
  let out = `![${name}](${mdPath(path)})`;
  if (note) out += `\n> Resim notu: ${note.replace(/\n+/g, " ")}`;
  return out;
}

/** Bir paragraf/başlık içeriğini, resimleri ayrı bloklara ayırarak serileştirir. */
function inlineBlocks(
  content: PMNode[] | undefined,
  meta: Record<string, ImageMeta>,
  mode: CopyMode,
  wrap: (s: string) => string,
): string[] {
  const out: string[] = [];
  let buf = "";
  // AI notu: seslendirilmeyen yazar notu. Markdown'da [NOT: …] olarak satır içinde kalır, düz metinde atlanır.
  let note: string | null = null;
  const endNote = () => {
    const t = note?.replace(/\s+/g, " ").trim();
    if (t && mode === "markdown") buf += `${buf && !/\s$/.test(buf) ? " " : ""}[NOT: ${t}]`;
    note = null;
  };
  const flush = () => {
    endNote();
    if (buf.trim()) out.push(wrap(buf.trim().replace(/ {2,}/g, " ")));
    buf = "";
  };
  for (const c of content ?? []) {
    if (isNote(c)) {
      note = (note ?? "") + (c.text ?? "");
      continue;
    }
    if (c.type === "hardBreak" && note !== null) {
      note += " ";
      continue;
    }
    endNote();
    if (c.type === "imageChip") {
      flush();
      const b = imageBlock(c, meta, mode);
      if (b) out.push(b);
    } else buf += inlineText(c, mode);
  }
  flush();
  return out;
}

function blocks(node: PMNode, meta: Record<string, ImageMeta>, mode: CopyMode, listPrefix = ""): string[] {
  switch (node.type) {
    case "doc":
      return (node.content ?? []).flatMap((c) => blocks(c, meta, mode));
    case "paragraph":
      return inlineBlocks(node.content, meta, mode, (s) => s);
    case "heading": {
      const lvl = Math.min(6, Math.max(1, node.attrs?.level ?? 1));
      return inlineBlocks(node.content, meta, mode, (s) => (mode === "markdown" ? `${"#".repeat(lvl)} ${s}` : s));
    }
    case "blockquote":
      return (node.content ?? [])
        .flatMap((c) => blocks(c, meta, mode))
        .map((b) => (mode === "markdown" ? b.split("\n").map((l) => `> ${l}`).join("\n") : b));
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const items = (node.content ?? []).map((li, i) => {
        const bullet = ordered ? `${i + 1}.` : "-";
        const inner = (li.content ?? []).flatMap((c) => blocks(c, meta, mode));
        const [first = "", ...rest] = inner;
        return [`${bullet} ${first}`, ...rest.map((r) => r.split("\n").map((l) => "  " + l).join("\n"))].join("\n");
      });
      return [items.join("\n")];
    }
    case "codeBlock":
      return [mode === "markdown" ? "```\n" + (node.content ?? []).map((c) => c.text ?? "").join("") + "\n```" : (node.content ?? []).map((c) => c.text ?? "").join("")];
    case "horizontalRule":
      return mode === "markdown" ? ["---"] : [];
    default:
      return [];
  }
}

export function exportDoc(doc: any, meta: Record<string, ImageMeta>, mode: CopyMode): string {
  if (!doc) return "";
  const body = blocks(doc as PMNode, meta, mode).join("\n\n").trim();
  const head =
    mode === "markdown" && body.includes("[NOT: ")
      ? "(Not: \"[NOT: …]\" içindekiler seslendirilmeyecek yazar notlarıdır; anlatım metnine dahil etme, bilgi/yönerge olarak kullan.)\n\n"
      : "";
  return head + body + "\n";
}

export function collectImagePaths(doc: any): Set<string> {
  const set = new Set<string>();
  const walk = (n: PMNode | undefined) => {
    if (!n) return;
    if (n.type === "imageChip" && n.attrs?.path) set.add(n.attrs.path);
    n.content?.forEach(walk);
  };
  walk(doc);
  return set;
}

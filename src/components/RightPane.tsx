import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { api } from "../lib/api";
import { collectImagePaths } from "../lib/copyExport";
import type { ImageMeta, Project } from "../lib/types";
import { ImageChip, prepareImage } from "./imageChip";
import { ImageViewer } from "./ImageViewer";

interface Props {
  project: Project;
  onDoc: (doc: any) => void;
  onMeta: (path: string, meta: ImageMeta | null) => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
  registerGetDoc: (fn: () => any) => void;
}

const UNDO_WINDOW_MS = 30_000;

export function RightPane({ project, onDoc, onMeta, onToast, registerGetDoc }: Props) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const known = useRef<Set<string>>(collectImagePaths(project.editorDoc));
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latestPaths = useRef<Set<string>>(known.current);
  const metaRef = useRef(project.imageMeta);
  metaRef.current = project.imageMeta;

  const removeImage = (path: string) => {
    pending.current.delete(path);
    if (latestPaths.current.has(path)) return;
    api.deleteImage(path).catch(() => {});
    onMeta(path, null);
  };

  const insertImages = async (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    for (const f of files) {
      try {
        const { data, ext } = await prepareImage(f);
        const saved = await api.saveImage(project.id, data, ext);
        known.current.add(saved.path);
        onMeta(saved.path, { name: saved.name, note: "" });
        const node = { type: "imageChip", attrs: { path: saved.path, name: saved.name } };
        const chain = ed.chain().focus();
        (pos !== undefined ? chain.insertContentAt(pos, node) : chain.insertContent(node)).run();
        if (pos !== undefined) pos += 1;
      } catch (e) {
        onToast(`Resim eklenemedi: ${e}`, "error");
      }
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: "Scriptini buraya yaz… (Ctrl+V ile resim yapıştırabilirsin)" }),
      ImageChip,
    ],
    content: project.editorDoc ?? "",
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: "tiptap-editor", spellcheck: "false" },
      handlePaste: (_v, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length) return false;
        void insertImages(files);
        return true;
      },
      handleDrop: (view, event, _s, moved) => {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (!files.length) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertImages(files, pos);
        return true;
      },
      handleClickOn: (_v, _pos, node) => {
        if (node.type.name === "imageChip") {
          setOpenPath(node.attrs.path);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const doc = editor.getJSON();
      onDoc(doc);
      const now = collectImagePaths(doc);
      latestPaths.current = now;
      for (const p of known.current) {
        if (!now.has(p) && !pending.current.has(p)) {
          pending.current.set(p, setTimeout(() => removeImage(p), UNDO_WINDOW_MS));
        }
      }
      for (const p of now) {
        known.current.add(p);
        const t = pending.current.get(p);
        if (t) {
          clearTimeout(t);
          pending.current.delete(p);
        }
      }
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    registerGetDoc(() => editor?.getJSON() ?? project.editorDoc);
  }, [editor, registerGetDoc, project.editorDoc]);

  // Proje değişince (bileşen sökülürken) bekleyen resim silmelerini uygula
  useEffect(
    () => () => {
      for (const [p, t] of pending.current) {
        clearTimeout(t);
        removeImage(p);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!editor) return null;
  const btn = (label: string, active: boolean, run: () => void, title?: string) => (
    <button className={"tb" + (active ? " on" : "")} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {label}
    </button>
  );
  const chain = () => editor.chain().focus();
  const words = editor.getText().trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="pane right-pane">
      <div className="pane-head">
        <span className="pane-title">Senaryo</span>
        <div className="toolbar">
          {btn("H1", editor.isActive("heading", { level: 1 }), () => chain().toggleHeading({ level: 1 }).run(), "Başlık 1")}
          {btn("H2", editor.isActive("heading", { level: 2 }), () => chain().toggleHeading({ level: 2 }).run(), "Başlık 2")}
          {btn("B", editor.isActive("bold"), () => chain().toggleBold().run(), "Kalın (Ctrl+B)")}
          {btn("I", editor.isActive("italic"), () => chain().toggleItalic().run(), "İtalik (Ctrl+I)")}
          {btn("•", editor.isActive("bulletList"), () => chain().toggleBulletList().run(), "Madde işaretli liste")}
          {btn("1.", editor.isActive("orderedList"), () => chain().toggleOrderedList().run(), "Numaralı liste")}
        </div>
        <span className="muted">{words} kelime</span>
      </div>
      <div className="editor-scroll" onClick={(e) => e.target === e.currentTarget && editor.commands.focus("end")}>
        <EditorContent editor={editor} className="editor-col" />
      </div>
      {openPath && (
        <ImageViewer
          path={openPath}
          meta={project.imageMeta[openPath] ?? { name: openPath.split(/[\\/]/).pop() ?? "resim", note: "" }}
          onNote={(note) => onMeta(openPath, { ...(project.imageMeta[openPath] ?? { name: openPath.split(/[\\/]/).pop() ?? "resim" }), note })}
          onClose={() => setOpenPath(null)}
        />
      )}
    </div>
  );
}

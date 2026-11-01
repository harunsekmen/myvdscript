import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { collectImagePaths } from "../lib/copyExport";
import { speak } from "../lib/speech";
import { buildTimed, collectTimedPaths } from "../lib/timed";
import { checkWords } from "../lib/wordCheck";
import type { ImageMeta, Project, Settings, TimedDoc } from "../lib/types";
import { ImageChip, prepareImage } from "./imageChip";
import { ImageViewer } from "./ImageViewer";
import { ConfirmDialog } from "./Dialogs";
import { SpeakIcon } from "./SpeakIcon";
import { TimedPane } from "./TimedPane";

export type RightTab = "write" | "timed";

interface Props {
  project: Project;
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  settings: Settings;
  hasGroqKey: boolean;
  onOpenSettings: () => void;
  onDoc: (doc: any) => void;
  onTimed: (doc: TimedDoc) => void;
  onPatchTimed: (fn: (d: TimedDoc) => TimedDoc) => void;
  onMeta: (path: string, meta: ImageMeta | null) => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
  registerGetDoc: (fn: () => any) => void;
}

const UNDO_WINDOW_MS = 30_000;
const MEDIA_EXTENSIONS = ["mp3", "mp4", "m4a", "wav", "webm", "ogg", "flac", "mpeg", "mpga"];

export function RightPane({ project, tab, onTab, settings, hasGroqKey, onOpenSettings, onDoc, onTimed, onPatchTimed, onMeta, onToast, registerGetDoc }: Props) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [pick, setPick] = useState<{ text: string; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const [replacePath, setReplacePath] = useState<string | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const alive = useRef(true);

  // Resim takibi: editör ve zamanlı altyazı birlikte değerlendirilir; hiçbirinde kalmayan resim silinir.
  const known = useRef<Set<string>>(new Set([...collectImagePaths(project.editorDoc), ...collectTimedPaths(project.timed)]));
  const editorPaths = useRef<Set<string>>(collectImagePaths(project.editorDoc));
  const timedPaths = useRef<Set<string>>(collectTimedPaths(project.timed));
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const isUsed = (p: string) => editorPaths.current.has(p) || timedPaths.current.has(p);

  const play = (text: string) => {
    void speak(text).then((ok) => ok || onToast("Ses çalınamadı (internet bağlantısını kontrol et)", "error"));
  };
  const removeImage = (path: string) => {
    pending.current.delete(path);
    if (isUsed(path)) return;
    api.deleteImage(path).catch(() => {});
    onMeta(path, null);
  };

  const reconcile = () => {
    const now = new Set([...editorPaths.current, ...timedPaths.current]);
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
  };

  /** Resmi kaydeder ve proje meta verisine ekler. */
  const saveImageFile = async (file: File) => {
    const { data, ext } = await prepareImage(file);
    const saved = await api.saveImage(project.id, data, ext);
    known.current.add(saved.path);
    onMeta(saved.path, { name: saved.name, note: "" });
    return saved;
  };

  const insertImages = async (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    for (const f of files) {
      try {
        const saved = await saveImageFile(f);
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
      handleDOMEvents: {
        mousedown: () => {
          setPick(null);
          return false;
        },
        mouseup: (view) => {
          // Seçim oturunca (kelime ya da öbek) seçimin tam ortasının üstünde dinle düğmesini göster
          setTimeout(() => {
            const { from, to, empty } = view.state.selection;
            if (empty || to - from > 200) return;
            const text = view.state.doc.textBetween(from, to, " ").trim().replace(/\s+/g, " ");
            if (!/\p{L}/u.test(text)) return;
            const sel = window.getSelection();
            let rect: DOMRect | null = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            if (!rect || !rect.width) {
              const a = view.coordsAtPos(from);
              const b = view.coordsAtPos(to);
              rect = new DOMRect(a.left, a.top, Math.max(b.right - a.left, 1), b.bottom - a.top);
            }
            setPick({ text, x: rect.left + rect.width / 2, y: rect.top });
          }, 0);
          return false;
        },
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
      editorPaths.current = collectImagePaths(doc);
      reconcile();
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    registerGetDoc(() => editor?.getJSON() ?? project.editorDoc);
  }, [editor, registerGetDoc, project.editorDoc]);

  useEffect(() => setPick(null), [tab]);

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

  const onTimedChange = (doc: TimedDoc) => {
    timedPaths.current = collectTimedPaths(doc);
    reconcile();
    onTimed(doc);
  };

  /** Zamanlı metni AI'a zamanlarıyla gönderir; yanlış kelime önerilerini belgeye ekler. */
  const runCheck = async (doc: TimedDoc) => {
    if (!settings.model) {
      onToast("AI kelime kontrolü için Ayarlar'dan bir model seçin", "error");
      return;
    }
    setChecking({ done: 0, total: 1 });
    try {
      const fixes = await checkWords(doc, settings, (done, total) => alive.current && setChecking({ done, total }));
      if (!alive.current) return;
      const n = Object.keys(fixes).length;
      onPatchTimed((d) => ({ ...d, suggestions: { ...(d.suggestions ?? {}), ...fixes } }));
      onToast(n ? `${n} kelime için öneri hazır; onaylayabilirsin` : "AI yanlış kelime bulmadı");
    } catch (e) {
      if (alive.current) onToast(`AI kelime kontrolü başarısız: ${e}`, "error");
    } finally {
      if (alive.current) setChecking(null);
    }
  };

  const transcribe = async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? "medya";
    setBusy(name);
    try {
      const r = await api.transcribeMedia(path, settings.sttLanguage);
      if (!alive.current) return;
      if (!r.words.length) throw new Error("Konuşma bulunamadı");
      const doc = buildTimed(r.words, name, r.language || "?");
      onTimedChange(doc);
      onTab("timed");
      onToast(`${r.words.length} kelime zamanlandı`);
      void runCheck(doc);
    } catch (e) {
      if (alive.current) onToast(`Ses çevrilemedi: ${e}`, "error");
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const addMedia = async () => {
    if (!hasGroqKey) {
      onToast("Önce Ayarlar'dan Groq API anahtarını girin", "error");
      onOpenSettings();
      return;
    }
    let picked: string | string[] | null = null;
    try {
      picked = await open({ multiple: false, directory: false, filters: [{ name: "Ses / video", extensions: MEDIA_EXTENSIONS }] });
    } catch (e) {
      onToast(`Dosya seçilemedi: ${e}`, "error");
      return;
    }
    if (typeof picked !== "string") return;
    if (project.timed?.items.some((i) => i.k === "w")) setReplacePath(picked);
    else void transcribe(picked);
  };

  if (!editor) return null;
  const btn = (label: string, active: boolean, run: () => void, title?: string) => (
    <button className={"tb" + (active ? " on" : "")} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {label}
    </button>
  );
  const chain = () => editor.chain().focus();
  const words = editor.getText().trim().split(/\s+/).filter(Boolean).length;
  const timedWords = project.timed?.items.filter((i) => i.k === "w").length ?? 0;
  const timedTab = tab === "timed" && !!project.timed;
  const clampX = (x: number) => Math.min(Math.max(x, 24), window.innerWidth - 24);

  return (
    <div className="pane right-pane">
      <div className="pane-head">
        {project.timed ? (
          <div className="rtabs" role="tablist">
            <button role="tab" aria-selected={!timedTab} className={"rtab" + (!timedTab ? " on" : "")} onClick={() => onTab("write")}>
              Senaryo
            </button>
            <button role="tab" aria-selected={timedTab} className={"rtab" + (timedTab ? " on" : "")} onClick={() => onTab("timed")} title="Kelime kelime zamanlı, otomatik çevrilmiş metin">
              Zamanlı metin
            </button>
          </div>
        ) : (
          <span className="pane-title">Senaryo</span>
        )}
        {!timedTab && (
          <div className="toolbar">
            {btn("H1", editor.isActive("heading", { level: 1 }), () => chain().toggleHeading({ level: 1 }).run(), "Başlık 1")}
            {btn("H2", editor.isActive("heading", { level: 2 }), () => chain().toggleHeading({ level: 2 }).run(), "Başlık 2")}
            {btn("B", editor.isActive("bold"), () => chain().toggleBold().run(), "Kalın (Ctrl+B)")}
            {btn("I", editor.isActive("italic"), () => chain().toggleItalic().run(), "İtalik (Ctrl+I)")}
            {btn("•", editor.isActive("bulletList"), () => chain().toggleBulletList().run(), "Madde işaretli liste")}
            {btn("1.", editor.isActive("orderedList"), () => chain().toggleOrderedList().run(), "Numaralı liste")}
          </div>
        )}
        <span className="muted pane-count">{timedTab ? `${timedWords} kelime · zamanlı` : `${words} kelime`}</span>
        {timedTab && (
          <button
            className="btn small"
            onClick={() => project.timed && runCheck(project.timed)}
            disabled={!!checking || !!busy}
            title="Zamanlı metni AI'a gönder; yanlış kelimeler için öneri al"
          >
            ✦ AI ile kontrol et
          </button>
        )}
        <button
          className="btn small media-add"
          onClick={addMedia}
          disabled={!!busy}
          title="Bilgisayardan ses veya video seç; kelime kelime zamanlı metne çevrilsin"
        >
          ＋ Ses / video
        </button>
      </div>
      {busy && (
        <div className="banner busy">
          <span>⏳ “{busy}” yazıya çevriliyor… (uzun dosyalarda birkaç dakika sürebilir)</span>
        </div>
      )}
      {checking && (
        <div className="banner busy">
          <span>✦ AI kelimeleri kontrol ediyor… ({checking.done}/{checking.total} parça)</span>
        </div>
      )}
      <div
        className="editor-scroll"
        style={{ display: timedTab ? "none" : undefined }}
        onClick={(e) => e.target === e.currentTarget && editor.commands.focus("end")}
      >
        <EditorContent editor={editor} className="editor-col" />
      </div>
      {timedTab && project.timed && (
        <TimedPane
          doc={project.timed}
          onDoc={onTimedChange}
          saveImage={saveImageFile}
          onOpenImage={setOpenPath}
          onToast={onToast}
        />
      )}
      {pick && (
        <button
          className="pron-pick"
          style={{ left: clampX(pick.x), top: pick.y - 8 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => play(pick.text)}
          title="Seçili metni dinle"
          aria-label="Seçili metni dinle"
        >
          <SpeakIcon />
        </button>
      )}
      {openPath && (
        <ImageViewer
          path={openPath}
          meta={project.imageMeta[openPath] ?? { name: openPath.split(/[\\/]/).pop() ?? "resim", note: "" }}
          onNote={(note) => onMeta(openPath, { ...(project.imageMeta[openPath] ?? { name: openPath.split(/[\\/]/).pop() ?? "resim" }), note })}
          onClose={() => setOpenPath(null)}
        />
      )}
      {replacePath && (
        <ConfirmDialog
          title="Zamanlı metin değişecek"
          message="Bu projedeki mevcut zamanlı metin, buradaki notlar ve resimler kaldırılacak. Devam edilsin mi?"
          confirmLabel="Yeni dosyayla değiştir"
          danger
          onConfirm={() => {
            const p = replacePath;
            setReplacePath(null);
            void transcribe(p);
          }}
          onCancel={() => setReplacePath(null)}
        />
      )}
    </div>
  );
}

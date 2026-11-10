import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { collectImagePaths, type CopyMode } from "../lib/copyExport";
import { CopyButton } from "./CopyButton";
import { speak } from "../lib/speech";
import { buildTimed, collectTimedPaths } from "../lib/timed";
import { NOTE_MARK, applyMoves, hasScriptAtts, placeScriptItems, refineWithAI } from "../lib/scriptPlace";
import { ScriptNote } from "./scriptNote";
import { checkWords } from "../lib/wordCheck";
import type { ImageMeta, Project, Settings, TimedDoc } from "../lib/types";
import { ImageChip, prepareImage } from "./imageChip";
import { MarkdownEnter } from "./mdShortcuts";
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
  onCopy: (mode: CopyMode) => Promise<void> | void;
  onCount: (label: string) => void;
}

/** Başlık, liste, alıntı, kod bloğu, kalın/italik ya da bağlantı içeren metin markdown sayılır. */
const looksLikeMarkdown = (t: string) =>
  /^(#{1,6}\s+\S|\s*[-*+]\s+\S|\s*\d+[.)]\s+\S|>\s?\S|```)/m.test(t) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/.test(t);

const UNDO_WINDOW_MS = 30_000;
const MEDIA_EXTENSIONS = ["mp3", "m4a", "wav", "ogg", "flac", "aac", "opus", "wma", "mpeg", "mpga", "mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts"];

export function RightPane({ project, tab, onTab, settings, hasGroqKey, onOpenSettings, onDoc, onTimed, onPatchTimed, onMeta, onToast, registerGetDoc, onCopy, onCount }: Props) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  // Seçim balonu: dinle (kısa seçimlerde) ve AI notuna çevir/notu kaldır
  const [pick, setPick] = useState<{ text: string; x: number; y: number; speak: boolean; note: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const [placing, setPlacing] = useState<{ done: number; total: number } | null>(null);
  const [replacePath, setReplacePath] = useState<string | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const alive = useRef(true);

  // Resim takibi: editör ve zamanlı altyazı birlikte değerlendirilir; hiçbirinde kalmayan resim silinir.
  const known = useRef<Set<string>>(new Set([...collectImagePaths(project.editorDoc), ...collectTimedPaths(project.timed)]));
  const editorPaths = useRef<Set<string>>(collectImagePaths(project.editorDoc));
  const timedPaths = useRef<Set<string>>(collectTimedPaths(project.timed));
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const isUsed = (p: string) => editorPaths.current.has(p) || timedPaths.current.has(p);
  // Senaryoda zamanlı metne yerleştirilecek resim ya da AI notu var mı (düğmeyi göstermek için)
  const editorAtts = useRef(hasScriptAtts(project.editorDoc));

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
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
      Placeholder.configure({ placeholder: "Scriptini buraya yaz… (Ctrl+V ile resim yapıştırabilir, metni seçip AI notuna çevirebilirsin: Ctrl+Shift+N)" }),
      ImageChip,
      ScriptNote,
      Markdown,
      MarkdownEnter,
    ],
    content: project.editorDoc ?? "",
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: "tiptap-editor", spellcheck: "false" },
      handlePaste: (_v, event) => {
        // Markdown yapısı taşıyan düz metin yapıştırılırsa biçimli olarak eklenir.
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        if (!Array.from(event.clipboardData?.files ?? []).some((f) => f.type.startsWith("image/")) && looksLikeMarkdown(plain)) {
          editorRef.current?.chain().focus().insertContent(plain, { contentType: "markdown" }).run();
          return true;
        }
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
          // Seçim oturunca seçimin tam ortasının üstünde balon: dinle (kısa seçimlerde) ve AI notuna çevir
          setTimeout(() => {
            const { from, to, empty } = view.state.selection;
            if (empty) return;
            const text = view.state.doc.textBetween(from, to, " ").trim().replace(/\s+/g, " ");
            if (!/[\p{L}\p{N}]/u.test(text)) return;
            const noteType = view.state.schema.marks[NOTE_MARK];
            const note = !!noteType && view.state.doc.rangeHasMark(from, to, noteType);
            const canSpeak = to - from <= 200 && /\p{L}/u.test(text);
            const sel = window.getSelection();
            let rect: DOMRect | null = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            if (!rect || !rect.width) {
              const a = view.coordsAtPos(from);
              const b = view.coordsAtPos(to);
              rect = new DOMRect(a.left, a.top, Math.max(b.right - a.left, 1), b.bottom - a.top);
            }
            // Uzun seçimde üst kenar ekran dışında kalabilir; balon görünür alanda tutulur
            const box = view.dom.closest(".editor-scroll")?.getBoundingClientRect();
            const y = Math.max(rect.top, (box?.top ?? 0) + 44);
            setPick({ text, x: rect.left + rect.width / 2, y, speak: canSpeak, note });
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
      editorAtts.current = hasScriptAtts(doc);
      reconcile();
    },
  });
  editorRef.current = editor;

  /** Seçili metni AI notuna çevirir; seçimde zaten not varsa not işaretini kaldırır. */
  const toggleNote = (remove: boolean) => {
    const ed = editorRef.current;
    if (!ed) return;
    const chain = ed.chain().focus();
    (remove ? chain.unsetMark(NOTE_MARK) : chain.setMark(NOTE_MARK)).run();
    setPick(null);
    if (!remove) onToast("Not olarak işaretlendi: seslendirmede aranmaz, zamanlı metne ilgili yere not olarak konur");
  };

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

  // Kelime sayısı durum çubuğunda gösterilir.
  const editorText = editor?.getText() ?? "";
  const timedWords = project.timed?.items.filter((i) => i.k === "w").length ?? 0;
  const timedActive = tab === "timed" && !!project.timed;
  useEffect(() => {
    const words = editorText.trim().split(/\s+/).filter(Boolean).length;
    onCount(timedActive ? `${timedWords} kelime · zamanlı` : `${words} kelime`);
  }, [editorText, timedWords, timedActive, onCount]);
  useEffect(() => () => onCount(""), [onCount]);

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
      const { fixes, drops } = await checkWords(doc, settings, (done, total) => alive.current && setChecking({ done, total }));
      if (!alive.current) return;
      const n = Object.keys(fixes).length;
      const m = Object.keys(drops).length;
      // AI'ın gereksiz bulduğu kelimeler yenilenir; elle yapılan işaretler korunur.
      onPatchTimed((d) => {
        const manual = Object.fromEntries(Object.entries(d.disfluent ?? {}).filter(([, k]) => k === "manual"));
        return { ...d, suggestions: { ...(d.suggestions ?? {}), ...fixes }, disfluent: { ...drops, ...manual } };
      });
      const parts = [n ? `${n} kelime için düzeltme önerisi` : "", m ? `${m} gereksiz kelime soluk gösterildi` : ""].filter(Boolean);
      onToast(parts.length ? `AI: ${parts.join(", ")}` : "AI yanlış ya da gereksiz kelime bulmadı");
    } catch (e) {
      if (alive.current) onToast(`AI kelime kontrolü başarısız: ${e}`, "error");
    } finally {
      if (alive.current) setChecking(null);
    }
  };

  /**
   * Senaryodaki resimleri zamanlı metne yerleştirir (senkron). Yeri kesin olmayanlar için `refine`, model seçiliyse
   * AI'a sorup resimleri doğru kelimeye taşır.
   */
  const placeAtts = (doc: TimedDoc) => {
    const editorDoc = editorRef.current?.getJSON() ?? project.editorDoc;
    const meta = project.imageMeta;
    const r = placeScriptItems(doc, editorDoc, meta);
    const placed = r.images + r.notes;
    const willRefine = r.approx.length > 0 && !!settings.model;
    const what = [r.images ? `${r.images} resim` : "", r.notes ? `${r.notes} not` : ""].filter(Boolean).join(" ve ");
    const summary = !placed
      ? ""
      : `${what} senaryodan yerleştirildi` +
        (!r.approx.length ? "" : willRefine ? ` (${r.approx.length} tanesinin yeri AI ile bulunuyor)` : ` (${r.approx.length} tanesinin yeri yaklaşık, kontrol et)`);
    const refine = async () => {
      if (!willRefine) return;
      setPlacing({ done: 0, total: 1 });
      try {
        const { moves, failed } = await refineWithAI(r.doc, editorDoc, meta, r.approx, r.ids, settings, (done, total) => alive.current && setPlacing({ done, total }));
        if (!alive.current) return;
        if (moves.size) onPatchTimed((d) => ({ ...d, items: applyMoves(d.items, moves) }));
        if (failed) onToast(`AI ${moves.size} ekin yerini buldu; ${failed} tanesi yaklaşık kaldı (kesik çerçeveli), sürükleyerek düzeltebilirsin`);
        else onToast(`AI ${moves.size} ekin yerini buldu`);
      } finally {
        if (alive.current) setPlacing(null);
      }
    };
    return { doc: r.doc, placed, summary, refine };
  };

  /** Senaryodaki resim ve notları mevcut zamanlı metne yeniden yerleştirir (senaryoya sonradan eklendiyse). */
  const replaceAtts = () => {
    if (!project.timed) return;
    const r = placeAtts(project.timed);
    if (!r.placed) {
      onToast("Senaryoda yerleştirilecek resim ya da not yok", "error");
      return;
    }
    onTimedChange(r.doc);
    onToast(r.summary);
    void r.refine();
  };

  const transcribe = async (path: string) => {
    const name = path.split(/[\\/]/).pop() ?? "medya";
    setBusy(name);
    try {
      const r = await api.transcribeMedia(path, settings.sttLanguage);
      if (!alive.current) return;
      if (!r.words.length) throw new Error("Konuşma bulunamadı");
      const placed = placeAtts(buildTimed(r.words, name, r.language || "?"));
      const doc = placed.doc;
      onTimedChange(doc);
      onTab("timed");
      onToast([`${r.words.length} kelime zamanlandı`, placed.summary].filter(Boolean).join(" · "));
      // Önce resim yerleri (kısa), sonra kelime kontrolü; aynı modele art arda gider.
      void placed.refine().finally(() => alive.current && runCheck(doc));
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
        <span className="spacer" />
        {timedTab && editorAtts.current && (
          <button
            className="btn small"
            onClick={replaceAtts}
            disabled={!!checking || !!busy || !!placing}
            title="Senaryodaki resimleri ve AI notlarını, söylendikleri yere göre zamanlı metne yeniden yerleştir (senaryodan gelenlerin konumu sıfırlanır; zamanlı metne elle eklediklerin kalır)"
          >
            🖼 Yerleştir
          </button>
        )}
        {timedTab && (
          <button
            className="btn small"
            onClick={() => project.timed && runCheck(project.timed)}
            disabled={!!checking || !!busy}
            title="Zamanlı metni AI'a gönder; yanlış kelimeler için öneri al, dolgu ve tekrarları işaretle"
          >
            ✦ AI kontrol
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
        <CopyButton onCopy={onCopy} timed={timedTab} />
      </div>
      {busy && (
        <div className="banner busy">
          <span>⏳ “{busy}” yazıya çevriliyor… (uzun dosyalarda birkaç dakika sürebilir)</span>
        </div>
      )}
      {placing && (
        <div className="banner busy">
          <span>✦ AI senaryodaki resim ve notların yerini buluyor… ({placing.done}/{placing.total})</span>
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
        <div className="pick-bar" style={{ left: clampX(pick.x), top: pick.y - 8 }} onMouseDown={(e) => e.preventDefault()}>
          {pick.speak && (
            <button className="pick-speak" onClick={() => play(pick.text)} title="Seçili metni dinle" aria-label="Seçili metni dinle">
              <SpeakIcon />
            </button>
          )}
          <button
            className={"pick-note" + (pick.note ? " on" : "")}
            onClick={() => toggleNote(pick.note)}
            title={
              pick.note
                ? "Not işaretini kaldır: metin yeniden seslendirilecek senaryo metni olur"
                : "AI notuna çevir (Ctrl+Shift+N): seslendirilmez; zamanlı metne ilgili yere not olarak konur ve AI'a not olarak gider"
            }
          >
            {pick.note ? "Notu kaldır" : "Nota çevir"}
          </button>
        </div>
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
          message="Bu projedeki mevcut zamanlı metin, buradaki elle eklenen notlar ve resimler kaldırılacak; senaryodaki resim ve notlar yeni kayda göre yeniden yerleştirilir. Devam edilsin mi?"
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

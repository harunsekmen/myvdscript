import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { DEFAULT_SILENCE_SEC, acceptedRanges, buildCuts, cutWordIds } from "../lib/cutList";
import { baseName, buildCues, toSrt, toVtt } from "../lib/subtitleExport";
import { fmtTime, moveItem, newId, setWordText, splitLines } from "../lib/timed";
import type { TimedDoc, TimedItem } from "../lib/types";
import { DISFLUENCY_LABEL, disfluentWords, extraCuts, toggleDisfluent } from "../lib/disfluency";
import { CutListPanel } from "./CutListPanel";

interface Props {
  doc: TimedDoc;
  onDoc: (doc: TimedDoc) => void;
  saveImage: (file: File) => Promise<{ path: string; name: string }>;
  onOpenImage: (path: string) => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
}

type WordItem = Extract<TimedItem, { k: "w" }>;

const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
const isAttached = (it: TimedItem) => it.k === "note" || it.k === "img";

const NoteIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

/**
 * Kelime kelime zamanlı metin.
 * Kural: Not ve resimler her zaman bir kelimeye bağlıdır ve o kelimeden sonra durur.
 * - Kelimeye tek tık: seçilir ve araç çubuğu çıkar (📝 Not · 🖼 Resim · ✎ Düzenle).
 * - Çift tık: kelimeyi düzenle.
 * - Yapıştırma: seçili kelimeden sonra (seçili yoksa son kelimeden sonra).
 * - Sürükle-bırak: bırakılan kelimenin arkasına koyar; not/resim de sürüklenip taşınır.
 */
export function TimedPane({ doc, onDoc, saveImage, onOpenImage, onToast }: Props) {
  const docRef = useRef(doc);
  docRef.current = doc;

  const [sel, setSel] = useState<string | null>(null);
  const [selRect, setSelRect] = useState<DOMRect | null>(null);
  // Not kartı: rozete tıklayınca açılır; ekran koordinatına göre konumlanır (kenara taşmaz)
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [noteRect, setNoteRect] = useState<DOMRect | null>(null);
  const pendingNote = useRef<string | null>(null);
  const [editWord, setEditWord] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const cancelWord = useRef(false);
  const dragId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageTarget = useRef<string | null>(null);

  const lines = useMemo(() => splitLines(doc.items), [doc.items]);

  // ---- Kesim listesi ve dışa aktarma ----
  const [showCuts, setShowCuts] = useState(false);
  const [expOpen, setExpOpen] = useState(false);
  const expRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !expRef.current?.contains(e.target as Node) && setExpOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const silenceSec = doc.cuts?.silenceSec ?? DEFAULT_SILENCE_SEC;
  // Gereksiz kelimeler (dolgu, tekrar, yarım cümle): yerel kurallar + AI + elle işaret. Metinde soluk gösterilir.
  const dis = useMemo(() => disfluentWords(doc), [doc]);
  const cuts = useMemo(() => {
    if (!showCuts) return [];
    const base = buildCuts(doc.items, silenceSec);
    return [...base, ...extraCuts(doc, base)].sort((a, b) => a.start - b.start || a.end - b.end);
  }, [showCuts, doc, silenceSec]);
  const cutIds = useMemo(
    () => (showCuts ? cutWordIds(doc.items, acceptedRanges(cuts, doc.cuts)) : new Set<string>()),
    [showCuts, cuts, doc.items, doc.cuts],
  );

  const exportSubs = async (kind: "srt" | "vtt") => {
    setExpOpen(false);
    const cues = buildCues(doc.items);
    if (!cues.length) {
      onToast("Dışa aktarılacak kelime yok", "error");
      return;
    }
    try {
      const path = await save({ defaultPath: `${baseName(doc.source)}.${kind}`, filters: [{ name: kind === "srt" ? "SubRip altyazı" : "WebVTT altyazı", extensions: [kind] }] });
      if (!path) return;
      await api.saveTextFile(path, kind === "srt" ? toSrt(cues) : toVtt(cues));
      onToast(`${cues.length} altyazı kaydedildi`);
    } catch (e) {
      onToast(`Kaydedilemedi: ${e}`, "error");
    }
  };
  const sugs = doc.suggestions ?? {};
  const wordById = useMemo(() => {
    const m = new Map<string, WordItem>();
    for (const it of doc.items) if (it.k === "w") m.set(it.id, it);
    return m;
  }, [doc.items]);
  const sugList = Object.entries(sugs)
    .map(([id, to]) => ({ id, to, from: wordById.get(id) }))
    .filter((x): x is { id: string; to: string; from: WordItem } => !!x.from)
    .sort((a, b) => a.from.s - b.from.s);

  // Her öğenin "bağlı olduğu" kelime: kendisi kelimeyse o, değilse önceki kelime.
  const anchorOf = useMemo(() => {
    const m = new Map<string, string>();
    let last: string | null = null;
    for (const it of doc.items) {
      if (it.k === "w") last = it.id;
      if (it.k === "w" || it.k === "note" || it.k === "img") {
        if (last) m.set(it.id, last);
      }
    }
    return m;
  }, [doc.items]);

  // Seçili kelime değişince / kaydırılınca araç çubuğunun konumunu ölç
  const measure = (id: string) => {
    const el = document.getElementById("w-" + id);
    setSelRect(el ? el.getBoundingClientRect() : null);
  };
  useLayoutEffect(() => {
    if (sel) measure(sel);
    else setSelRect(null);
  }, [sel, doc.items]);

  const openNote = (id: string) => {
    const el = document.getElementById("n-" + id);
    setNoteRect(el ? el.getBoundingClientRect() : null);
    setNoteOpen(id);
  };
  const closeNote = () => {
    const cur = noteOpen;
    setNoteOpen(null);
    setNoteRect(null);
    // Boş bırakılan yeni not kendiliğinden silinir
    if (cur) {
      const it = docRef.current.items.find((i) => i.k === "note" && i.id === cur);
      if (it && it.k === "note" && !it.text.trim()) commit(docRef.current.items.filter((i) => i !== it));
    }
  };

  // Yeni eklenen notun rozeti DOM'a gelince kartı aç
  useLayoutEffect(() => {
    if (pendingNote.current && document.getElementById("n-" + pendingNote.current)) {
      const id = pendingNote.current;
      pendingNote.current = null;
      openNote(id);
    }
  }, [doc.items]);

  // Dışarı tıklayınca / Esc'e basınca / kaydırınca not kartını kapat
  useLayoutEffect(() => {
    if (!noteOpen) return;
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".npop") && !t.closest(".tn-badge")) closeNote();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && closeNote();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteOpen]);

  const commit = (items: TimedItem[], suggestions: Record<string, string> = sugs) =>
    onDoc({ ...docRef.current, items, suggestions });

  /** Bir kelimenin arkasına, bağlı not/resimlerinin sonuna öğe ekler. */
  const insertAfter = (wordId: string | null, make: (id: string) => TimedItem) => {
    const items = [...docRef.current.items];
    let idx: number;
    if (wordId) {
      idx = items.findIndex((i) => i.k === "w" && i.id === wordId);
      if (idx < 0) idx = items.length - 1;
      idx += 1;
      while (idx < items.length && isAttached(items[idx])) idx++;
    } else {
      const lastWord = items.map((i) => i.k).lastIndexOf("w");
      idx = lastWord < 0 ? items.length : lastWord + 1;
      while (idx < items.length && isAttached(items[idx])) idx++;
    }
    const item = make(newId());
    items.splice(idx, 0, item);
    commit(items);
    return item;
  };

  const addNote = (wordId: string) => {
    const it = insertAfter(wordId, (id) => ({ k: "note", id, text: "" })) as { id: string };
    pendingNote.current = it.id;
  };

  const addImages = async (files: File[], wordId: string | null) => {
    const saved: { path: string; name: string }[] = [];
    for (const f of files) {
      try {
        saved.push(await saveImage(f));
      } catch (e) {
        onToast(`Resim eklenemedi: ${e}`, "error");
      }
    }
    if (!saved.length) return;
    const items = [...docRef.current.items];
    let idx: number;
    const base = wordId && items.some((i) => i.k === "w" && i.id === wordId) ? wordId : null;
    if (base) {
      idx = items.findIndex((i) => i.k === "w" && i.id === base) + 1;
    } else {
      const lw = items.map((i) => i.k).lastIndexOf("w");
      idx = lw < 0 ? items.length : lw + 1;
    }
    while (idx < items.length && isAttached(items[idx])) idx++;
    items.splice(idx, 0, ...saved.map((s) => ({ k: "img" as const, id: newId(), path: s.path, name: s.name })));
    commit(items);
    const w = base ?? (sel && wordById.has(sel) ? sel : null);
    if (w) flash(w);
    onToast(`${saved.length} resim ${wordText(w)} kelimesinden sonra eklendi`);
  };

  const wordText = (id: string | null) => (id && wordById.get(id) ? `“${wordById.get(id)!.w}”` : "son");

  const removeById = (id: string) => {
    const items = docRef.current.items;
    const idx = items.findIndex((i) => isAttached(i) && i.id === id);
    if (idx < 0) return;
    if (noteOpen === id) closeNote();
    commit(items.filter((_, i) => i !== idx));
  };

  const setNoteText = (id: string, text: string) =>
    commit(docRef.current.items.map((i) => (i.k === "note" && i.id === id ? { ...i, text } : i)));

  const moveDragged = (id: string, wordId: string | null) => {
    const items = docRef.current.items;
    const from = items.findIndex((i) => isAttached(i) && i.id === id);
    if (from < 0) return;
    const without = items.filter((_, i) => i !== from);
    const dragged = items[from];
    let idx: number;
    if (wordId) {
      idx = without.findIndex((i) => i.k === "w" && i.id === wordId) + 1;
      while (idx < without.length && isAttached(without[idx])) idx++;
    } else idx = without.length;
    const next = [...without];
    // Elle taşınan resmin konumu artık kullanıcı onaylıdır
    next.splice(idx, 0, (dragged.k === "img" || dragged.k === "note") && dragged.approx ? { ...dragged, approx: undefined } : dragged);
    commit(next);
    if (wordId) flash(wordId);
  };

  // ---- AI önerileri ----
  const accept = (id: string) => {
    const to = sugs[id];
    if (to === undefined) return;
    const { [id]: _, ...rest } = sugs;
    commit(setWordText(docRef.current.items, id, to), rest);
  };
  const reject = (id: string) => {
    const { [id]: _, ...rest } = sugs;
    commit(docRef.current.items, rest);
  };
  const acceptAll = () => {
    let items = docRef.current.items;
    for (const s of sugList) items = setWordText(items, s.id, s.to);
    commit(items, {});
    onToast(`${sugList.length} öneri uygulandı`);
  };
  const rejectAll = () => commit(docRef.current.items, {});
  const focusWord = (id: string) => {
    setSel(id);
    flash(id, true);
  };
  const flash = (id: string, scroll = false) => {
    const el = document.getElementById("w-" + id);
    if (!el) return;
    if (scroll) el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };

  // ---- Kelime düzenleme ----
  const finishWordEdit = (id: string, text: string) => {
    setEditWord(null);
    if (cancelWord.current) {
      cancelWord.current = false;
      return;
    }
    const t = text.trim();
    const cur = wordById.get(id);
    if (!cur || !t || t === cur.w) return;
    const { [id]: _, ...rest } = sugs;
    commit(setWordText(docRef.current.items, id, t), rest);
  };

  // ---- Yapıştırma ve sürükle-bırak ----
  const wordAt = (target: EventTarget | null): string | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-anchor]") as HTMLElement | null | undefined;
    return el?.dataset.anchor ?? null;
  };
  const targetWord = () => (sel && wordById.has(sel) ? sel : null);

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
    const files = imageFiles(e.clipboardData.files);
    if (!files.length) return;
    e.preventDefault();
    void addImages(files, targetWord());
  };
  const onDragStartItem = (id: string) => (e: DragEvent) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.types).includes("Files");
    if (!dragId.current && !files) return;
    e.preventDefault();
    const w = wordAt(e.target);
    if (w !== dropId) setDropId(w);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropId(null);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const w = wordAt(e.target) ?? targetWord();
    setDropId(null);
    if (dragId.current) {
      e.preventDefault();
      const id = dragId.current;
      dragId.current = null;
      moveDragged(id, w);
      return;
    }
    const files = imageFiles(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    void addImages(files, w);
  };
  const onDragEnd = () => {
    dragId.current = null;
    setDropId(null);
  };

  const pickImageFor = (wordId: string) => {
    imageTarget.current = wordId;
    fileInput.current?.click();
  };

  const selectWord = (id: string) => {
    if (sel === id) return;
    setSel(id);
  };

  const renderItem = (item: TimedItem, idx: number, items: TimedItem[]) => {
    const anchor = item.k === "br" ? "" : anchorOf.get(item.id) ?? "";
    switch (item.k) {
      case "w": {
        const sug = sugs[item.id];
        const isEditing = editWord === item.id;
        const isSel = sel === item.id;
        const isDrop = dropId === item.id;
        if (isEditing) {
          return (
            <input
              key={item.id}
              className="wedit"
              autoFocus
              defaultValue={item.w}
              style={{ width: `${Math.max(3, item.w.length + 1)}ch` }}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => finishWordEdit(item.id, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  cancelWord.current = true;
                  e.currentTarget.blur();
                }
              }}
            />
          );
        }
        return (
          <span key={item.id} className="tw-wrap">
            <span
              id={"w-" + item.id}
              className={
                "tw" +
                (sug !== undefined ? " sug" : "") +
                (dis.has(item.id) ? " dis" : "") +
                (cutIds.has(item.id) ? " cut" : "") +
                (isSel ? " sel" : "") +
                (isDrop ? " drop" : "")
              }
              title={dis.has(item.id) ? `${DISFLUENCY_LABEL[dis.get(item.id)!]}: kopyalarken işaretlenir` : undefined}
              data-anchor={item.id}
              data-time={fmtTime(item.s, 1)}
              onClick={() => selectWord(item.id)}
              onDoubleClick={() => {
                setSel(item.id);
                setEditWord(item.id);
              }}
            >
              {item.w}
            </span>
            {sug !== undefined && (
              <span className="sug-chip">
                <span className="sug-arrow">→</span>
                <span className="sug-to">{sug}</span>
                <button className="sug-ok" title="Öneriyi onayla" onClick={() => accept(item.id)}>✓</button>
                <button className="sug-no" title="Öneriyi reddet" onClick={() => reject(item.id)}>✕</button>
              </span>
            )}
          </span>
        );
      }
      case "note":
        return (
          <span
            key={item.id}
            className="tnote-wrap"
            data-anchor={anchor}
            draggable
            onDragStart={onDragStartItem(item.id)}
            onDragEnd={onDragEnd}
          >
            <button
              id={"n-" + item.id}
              className={"tn-badge" + (noteOpen === item.id ? " on" : "") + (item.approx ? " approx" : "")}
              title={
                (item.approx
                  ? "Konumu yaklaşık (senaryodan): doğru kelimeye sürükleyip bırakınca onaylanır.\n"
                  : item.from === "script"
                    ? "Senaryodaki AI notu, ilgili yere otomatik yerleştirildi.\n"
                    : "") + (item.text ? item.text : "Not (boş)")
              }
              onClick={() => openNote(item.id)}
            >
              <NoteIcon />
            </button>
          </span>
        );
      case "img":
        return (
          <span key={item.id} className="timg-wrap" data-anchor={anchor} draggable onDragStart={onDragStartItem(item.id)} onDragEnd={onDragEnd}>
            <span
              className={"image-chip tchip" + (item.approx ? " approx" : "")}
              title={
                (item.approx
                  ? "Konumu yaklaşık: konuşmada senaryodaki yeri tam bulunamadı. Doğru kelimeye sürükleyip bırakınca onaylanır.\n"
                  : item.from === "script"
                    ? "Senaryodan, söylendiği yere otomatik yerleştirildi.\n"
                    : "") + item.path
              }
              onClick={() => onOpenImage(item.path)}
            >
              <span className="chip-ico" />
              {item.approx && <span className="approx-mark">≈</span>}
              {item.name}
              <button
                className="tchip-x"
                title="Resmi kaldır"
                onClick={(e) => {
                  e.stopPropagation();
                  removeById(item.id);
                }}
              >
                ×
              </button>
            </span>
          </span>
        );
      default:
        return null;
    }
  };

  const selWord = sel ? wordById.get(sel) : undefined;

  return (
    <div className="timed-wrap">
    {doc.items.length > 0 && (
      <div className="timed-bar">
        <button className={"btn small" + (showCuts ? " primary" : "")} onClick={() => setShowCuts(!showCuts)} title="Sessizlik, dolgu sesi ve tekrarları bulup kesim listesi çıkar">
          ✂ Kesim listesi
        </button>
        <span className="spacer" />
        <div className="copy-btn" ref={expRef}>
          <button className="btn small" onClick={() => setExpOpen(!expOpen)}>Dışa aktar ▾</button>
          {expOpen && (
            <div className="menu right">
              <button onClick={() => exportSubs("srt")}>Altyazı (.srt) <span className="muted">DaVinci, Premiere, CapCut</span></button>
              <button onClick={() => exportSubs("vtt")}>Altyazı (.vtt) <span className="muted">WebVTT</span></button>
            </div>
          )}
        </div>
      </div>
    )}
    {showCuts && <CutListPanel doc={doc} cuts={cuts} onDoc={onDoc} onJump={focusWord} onToast={onToast} />}
    <div className="timed" tabIndex={0} onPaste={onPaste} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onScroll={() => {
      if (sel) measure(sel);
      if (noteOpen) closeNote();
    }} onClick={(e) => {
      if (!(e.target as HTMLElement).closest("[data-anchor]") && !(e.target as HTMLElement).closest(".wbar")) setSel(null);
    }}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = imageFiles(e.target.files);
          e.target.value = "";
          if (files.length) void addImages(files, imageTarget.current);
        }}
      />
      {sugList.length > 0 && (
        <div className="sug-panel">
          <div className="sug-head">
            <span className="sug-title">✦ AI önerileri</span>
            <span className="sug-count">{sugList.length}</span>
            <span className="spacer" />
            <button className="btn small" onClick={rejectAll}>Tümünü reddet</button>
            <button className="btn small primary" onClick={acceptAll}>Tümünü onayla</button>
          </div>
          <div className="sug-list">
            {sugList.map((s) => (
              <div key={s.id} className="sug-row" onClick={() => focusWord(s.id)} title="Kelimeye git">
                <span className="sug-from">{s.from.w}</span>
                <span className="sug-arrow">→</span>
                <span className="sug-to">{s.to}</span>
                <span className="spacer" />
                <button className="sug-ok" title="Onayla" onClick={(e) => (e.stopPropagation(), accept(s.id))}>✓</button>
                <button className="sug-no" title="Reddet" onClick={(e) => (e.stopPropagation(), reject(s.id))}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="timed-col">
        {doc.items.length === 0 ? (
          <div className="timed-empty muted">Zamanlı metin boş. Sağ üstteki “＋ Ses / video” ile bir dosya ekleyin.</div>
        ) : (
          lines.map((line, li) => {
            return (
              <div key={li} className="tl">
                {line.items.map(({ item, idx }) => renderItem(item, idx, doc.items))}
              </div>
            );
          })
        )}
      </div>

      {noteOpen && noteRect && (() => {
        const note = doc.items.find((i) => i.k === "note" && i.id === noteOpen);
        if (!note || note.k !== "note") return null;
        const W = 300;
        const left = Math.min(Math.max(noteRect.left + noteRect.width / 2, W / 2 + 12), window.innerWidth - W / 2 - 12);
        const above = noteRect.top > 170;
        const style = above
          ? { left, top: noteRect.top - 8, transform: "translate(-50%, -100%)" }
          : { left, top: noteRect.bottom + 8, transform: "translate(-50%, 0)" };
        return (
          <div className="npop" style={style}>
            <div className="npop-head">
              <span className="tn-label">NOT</span>
              <span className="spacer" />
              <button className="tn-del" title="Notu sil" onClick={() => removeById(note.id)}>🗑 Sil</button>
            </div>
            <textarea
              autoFocus
              rows={4}
              value={note.text}
              placeholder="Notunuzu yazın… (AI'a da gidecek)"
              onChange={(e) => setNoteText(note.id, e.target.value)}
            />
            <div className="npop-foot">
              <span className="muted">Dışarı tıkla ya da Esc ile kapat</span>
              <button className="btn small primary" onClick={closeNote}>Tamam</button>
            </div>
          </div>
        );
      })()}

      {selWord && selRect && (
        <div className="wbar" style={{ left: selRect.left + selRect.width / 2, top: selRect.top - 8 }} onMouseDown={(e) => e.preventDefault()}>
          <span className="wbar-word">{selWord.w}</span>
          <button onClick={() => addNote(selWord.id)} title="Bu kelimeden sonra not ekle">📝 Not</button>
          <button onClick={() => pickImageFor(selWord.id)} title="Bu kelimeden sonra bilgisayardan resim ekle">🖼 Resim</button>
          <button onClick={() => setEditWord(selWord.id)} title="Kelimeyi düzenle (çift tık)">✎ Düzenle</button>
          {dis.has(selWord.id) ? (
            <button onClick={() => onDoc(toggleDisfluent(docRef.current, selWord.id, false))} title="Bu kelime gereksiz değil; normal göster">
              ◉ Gerekli
            </button>
          ) : (
            <button onClick={() => onDoc(toggleDisfluent(docRef.current, selWord.id, true))} title="Dolgu/tekrar gibi gereksiz olarak işaretle (soluk gösterilir)">
              ◌ Gereksiz
            </button>
          )}
        </div>
      )}

    </div>
    <div className="timed-foot">{doc.source}</div>
    </div>
  );
}

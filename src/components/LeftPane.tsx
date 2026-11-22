import { activeModel } from "../lib/aiProvider";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { onYtdlpStatus } from "../lib/api";
import { runInsightRequest } from "../lib/insights";
import { segStyle } from "../lib/colors";
import { CUSTOM_PROMPT_PLACEHOLDER } from "../lib/prompts";
import { audioRange, markTimeAt, paragraphsOf, sentenceAtTime } from "../lib/segmentParser";
import { activeSource, sourceLabel } from "../lib/sources";
import { speak } from "../lib/speech";
import { VOICE_RECORD_EVENT } from "../lib/voice";
import type { ChatMessage, Insight, ProcState, Project, SentenceMark, Segment, Settings } from "../lib/types";
import { getVideoState, playAt, subscribeVideo, videoIdOf } from "../lib/youtube";
import { ChatPanel } from "./ChatPanel";
import { PromptDialog } from "./Dialogs";
import { InsightCard } from "./InsightCard";
import { TextEditDialog } from "./TextEditDialog";
import { SpeakIcon } from "./SpeakIcon";

/** Seslendirme tek seferde en fazla bu kadar karakteri okur (sağ panelle aynı sınır). */
const SPEAK_MAX_CHARS = 200;

interface Props {
  project: Project;
  settings: Settings;
  models: string[];
  proc: ProcState;
  /** Bu kaynak, başka bir işlem bitince işlenmek üzere sırada mı? */
  queued: boolean;
  onDequeue: () => void;
  onInsights: (sourceId: string, insights: Insight[]) => void;
  onChat: (sourceId: string, chat: ChatMessage[]) => void;
  onReprocess: () => void;
  onEditText: (sourceId: string, segments: Segment[]) => void;
  onCustomRun: (prompt: string) => void;
  onCancel: () => void;
  onResume: () => void;
  /** Etkin (boş) kaynak için bağlantı + isteğe bağlı başlıkla başlat. */
  onFetchUrl: (url: string, title?: string) => void;
  onSelectSource: (id: string) => void;
  onAddSource: (url: string, title?: string) => void;
  /** Etkin (boş) kaynak için yapıştırılan metinle başlat. */
  onFetchText: (text: string, title?: string) => void;
  onAddTextSource: (text: string, title?: string) => void;
  onRemoveSource: (id: string) => void;
  onPickSubtitle: () => void;
  onRestore: (index: number) => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
}

interface Sel {
  segmentId: string;
  para: number;
  start: number;
  end: number;
  quote: string;
  context: string;
  rect: { left: number; top: number; width: number };
}

interface ParaOpts {
  segId: string;
  para: number;
  marks?: SentenceMark[];
  cur: { start: number; end: number } | null;
}

/**
 * Paragrafı; açıklama vurgularını, çalan cümleyi ve cümle zamanlarını (data-t) birlikte üretir.
 * Her parça, bulunduğu cümlenin zamanını data-t ile taşır; çift tıklayınca oradan başlamak için kullanılır.
 */
function renderPara(text: string, insights: Insight[], onOpen: (id: string, e: React.MouseEvent) => void, o: ParaOpts) {
  const list = insights
    .filter((i) => i.segmentId === o.segId && i.para === o.para)
    .sort((a, b) => a.start - b.start);
  const ivs: Insight[] = [];
  let pos = 0;
  for (const ins of list) {
    if (ins.start < pos || ins.end > text.length || ins.end <= ins.start) continue;
    ivs.push(ins);
    pos = ins.end;
  }
  const cuts = new Set<number>([0, text.length]);
  for (const i of ivs) cuts.add(i.start).add(i.end);
  for (const m of o.marks ?? []) if (m.para === o.para && m.start <= text.length) cuts.add(m.start);
  if (o.cur) cuts.add(o.cur.start).add(o.cur.end);
  const pts = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((a, b) => a - b);

  const out: React.ReactNode[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    if (a === b) continue;
    const piece = text.slice(a, b);
    const ins = ivs.find((i) => a >= i.start && a < i.end);
    const inCur = !!o.cur && a >= o.cur.start && a < o.cur.end;
    const t = markTimeAt(o.marks, o.para, a);
    let node: React.ReactNode = inCur ? <span className="cur">{piece}</span> : piece;
    if (ins) {
      node = (
        <mark className="hl" data-insight={ins.id} onClick={(e) => onOpen(ins.id, e)}>
          {node}
        </mark>
      );
    }
    out.push(
      <span key={k} data-t={t ?? undefined}>
        {node}
      </span>,
    );
  }
  return out;
}

/** Bağlantı + isteğe bağlı başlık girişi (ilk kaynak ve "＋ Kaynak" için ortak). */
function LinkForm({
  initialUrl = "",
  initialTitle = "",
  submitLabel,
  autoFocus,
  onSubmit,
}: {
  initialUrl?: string;
  initialTitle?: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (url: string, title?: string) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle);
  const go = () => url.trim() && onSubmit(url.trim(), title.trim() || undefined);
  return (
    <div className="link-start">
      <input
        className="input"
        placeholder="https://www.youtube.com/watch?v=…"
        spellCheck={false}
        autoFocus={autoFocus}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()}
      />
      <input
        className="input"
        placeholder="Başlık (isteğe bağlı)"
        spellCheck={false}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()}
      />
      <button className="btn primary" disabled={!url.trim()} onClick={go}>
        {submitLabel}
      </button>
    </div>
  );
}

/** Kendi metnini yapıştırma: başlık (isteğe bağlı) + metin alanı. Ctrl+Enter ile gönderilir. */
function TextForm({
  submitLabel,
  autoFocus,
  onSubmit,
}: {
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (text: string, title?: string) => void;
}) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const go = () => text.trim() && onSubmit(text.trim(), title.trim() || undefined);
  return (
    <div className="text-start">
      <input
        className="input"
        placeholder="Başlık (isteğe bağlı)"
        spellCheck={false}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="input"
        placeholder="Metni buraya yapıştırın…"
        autoFocus={autoFocus}
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && go()}
      />
      <div className="text-start-foot">
        <span className="muted">{text.trim() ? `${text.trim().length.toLocaleString("tr-TR")} karakter · ` : ""}Ctrl+Enter</span>
        <button className="btn primary" disabled={!text.trim()} onClick={go}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

/** Kaynak girişi: YouTube bağlantısı ya da yapıştırılan metin. */
function SourceForm({
  initialUrl,
  initialTitle,
  submitLabel,
  autoFocus,
  onUrl,
  onText,
}: {
  initialUrl?: string;
  initialTitle?: string;
  submitLabel: string;
  autoFocus?: boolean;
  onUrl: (url: string, title?: string) => void;
  onText: (text: string, title?: string) => void;
}) {
  const [mode, setMode] = useState<"url" | "text">("url");
  return (
    <div className="source-form">
      <div className="seg-toggle" role="tablist">
        <button role="tab" aria-selected={mode === "url"} className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>
          Video bağlantısı
        </button>
        <button role="tab" aria-selected={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>
          Metin yapıştır
        </button>
      </div>
      {mode === "url" ? (
        <LinkForm initialUrl={initialUrl} initialTitle={initialTitle} submitLabel={submitLabel} autoFocus={autoFocus} onSubmit={onUrl} />
      ) : (
        <TextForm submitLabel={submitLabel} autoFocus onSubmit={onText} />
      )}
    </div>
  );
}

export function LeftPane({
  project,
  settings,
  models,
  proc,
  queued,
  onDequeue,
  onInsights,
  onChat,
  onReprocess,
  onCustomRun,
  onEditText,
  onCancel,
  onResume,
  onFetchUrl,
  onSelectSource,
  onAddSource,
  onFetchText,
  onAddTextSource,
  onRemoveSource,
  onPickSubtitle,
  onRestore,
  onToast,
}: Props) {
  const source = activeSource(project);
  // Çalışan işlem başka bir kaynağa aitse bu sekmede boşta görünür; canlı akış yalnız kendi kaynağında gösterilir.
  const mine = proc.sourceId === source.id;
  const busyHere = proc.running && mine;
  const segments = mine && proc.live ? proc.live : source.segments;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; text: string; error?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [procMenu, setProcMenu] = useState(false);
  const procRef = useRef<HTMLDivElement>(null);
  const [activeSeg, setActiveSeg] = useState(0);
  const [adding, setAdding] = useState(false);
  const runRef = useRef<{ id: string; cancel: () => void } | null>(null);
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem("sa.chatOpen") === "1");
  const [chatQuote, setChatQuote] = useState<string | null>(null);
  const [chatH, setChatH] = useState(() => Number(localStorage.getItem("sa.chatH")) || 0.42);
  const paneRef = useRef<HTMLDivElement>(null);
  const insightsRef = useRef(source.insights);
  insightsRef.current = source.insights;

  const paras = useMemo(() => new Map(segments.map((s) => [s.id, paragraphsOf(s.text)])), [segments]);

  // Proje ya da kaynak değişince açık kart/seçim kapanır (açıklama sonucu yanlış kaynağa yazılmasın).
  useEffect(() => {
    runRef.current?.cancel();
    setActiveId(null);
    setSel(null);
    setLive(null);
    setAdding(false);
    setCustomOpen(false);
    setEditOpen(false);
    setChatQuote(null);
  }, [project.id, source.id]);

  const readSelection = useCallback(() => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return setSel(null);
    const range = s.getRangeAt(0);
    const scroll = scrollRef.current;
    if (!scroll || !scroll.contains(range.commonAncestorContainer)) return setSel(null);
    const startEl = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : (range.startContainer as Element))?.closest<HTMLElement>("p[data-para]");
    if (!startEl) return setSel(null);
    const segmentId = startEl.dataset.seg!;
    const para = Number(startEl.dataset.para);
    const pre = document.createRange();
    pre.selectNodeContents(startEl);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const paraText = paras.get(segmentId)?.[para] ?? "";
    const quote = s.toString().replace(/\s+/g, " ").trim();
    if (!quote) return setSel(null);
    const endEl = (range.endContainer.nodeType === 3 ? range.endContainer.parentElement : (range.endContainer as Element))?.closest("p[data-para]");
    let end = start + s.toString().length;
    if (endEl !== startEl) end = paraText.length;
    end = Math.min(end, paraText.length);
    const list = paras.get(segmentId) ?? [];
    const context = [list[para - 1], list[para], list[para + 1]].filter(Boolean).join("\n\n");
    const r = range.getBoundingClientRect();
    setSel({ segmentId, para, start, end, quote, context, rect: { left: r.left, top: r.top, width: r.width } });
  }, [paras]);

  useEffect(() => {
    const onUp = () => setTimeout(readSelection, 0);
    const el = scrollRef.current;
    el?.addEventListener("mouseup", onUp);
    el?.addEventListener("keyup", onUp);
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".sel-pop")) setSel(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      el?.removeEventListener("mouseup", onUp);
      el?.removeEventListener("keyup", onUp);
      document.removeEventListener("mousedown", onDown);
    };
  }, [readSelection]);

  const runInsight = useCallback(
    (insight: Insight, model: string, context: string) => {
      const sourceId = source.id;
      runRef.current?.cancel();
      const kind = insight.kind ?? "explain";
      const h = runInsightRequest(settings, kind, model, insight.quote, context);
      runRef.current = { id: insight.id, cancel: h.cancel };
      setLive({ id: insight.id, text: "" });
      h.done
        .then((result) => {
          const res = { id: crypto.randomUUID(), model, ...result, provider: settings.aiProvider, createdAt: Date.now() };
          onInsights(sourceId, insightsRef.current.map((i) => (i.id === insight.id ? { ...i, results: [...i.results, res] } : i)));
          setLive(null);
        })
        .catch((e) => {
          if (e.message === "İptal edildi") return;
          setLive({ id: insight.id, text: "", error: e.message });
        });
    },
    [settings, onInsights, source.id],
  );

  const addInsight = (kind: "explain" | "factcheck") => {
    if (!sel) return;
    if (!activeModel(settings)) return onToast("Önce Ayarlar'dan bir model seçin", "error");
    const insight: Insight = {
      kind,
      id: crypto.randomUUID(),
      segmentId: sel.segmentId,
      para: sel.para,
      start: sel.start,
      end: sel.end,
      quote: sel.quote,
      results: [],
    };
    onInsights(source.id, [...source.insights, insight]);
    insightsRef.current = [...insightsRef.current, insight];
    setActiveId(insight.id);
    window.getSelection()?.removeAllRanges();
    setSel(null);
    runInsight(insight, activeModel(settings, true), sel.context);
  };

  const toggleChat = (open = !chatOpen) => {
    setChatOpen(open);
    localStorage.setItem("sa.chatOpen", open ? "1" : "0");
  };

  // Seçili metni alıntı olarak sohbete ekler.
  const askSel = () => {
    if (!sel) return;
    setChatQuote(sel.quote);
    toggleChat(true);
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  // Sohbet bölmesinin yüksekliğini sürükleyerek ayarla (sol panelin oranı olarak).
  const startChatDrag = (e: React.PointerEvent) => {
    const pane = paneRef.current;
    if (!pane) return;
    e.preventDefault();
    const r = pane.getBoundingClientRect();
    let h = chatH;
    const move = (ev: PointerEvent) => {
      h = Math.min(0.85, Math.max(0.18, (r.bottom - ev.clientY) / r.height));
      setChatH(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("sa.chatH", String(h));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Seçili cümlenin orijinal sesi (zaman işaretleri varsa); yoksa seslendirme (TTS).
  const speakSel = () => {
    if (!sel) return;
    const range = audioRange(segments.find((s) => s.id === sel.segmentId)?.marks, sel);
    if (range && hasVideo) {
      try {
        playAt(range.from, range.to ?? range.from + 60);
      } catch (e: any) {
        onToast(`Video oynatılamadı: ${e?.message ?? e}`, "error");
      }
      return;
    }
    void speak(sel.quote).then((ok) => ok || onToast("Ses çalınamadı (internet bağlantısını kontrol et)", "error"));
  };

  // Orta paneldeki gömülü video: çalan cümlenin vurgusu.
  const vs = useSyncExternalStore(subscribeVideo, getVideoState);
  const videoId = videoIdOf(source.url);
  const hasVideo = !!videoId && segments.some((s) => s.marks?.length);
  // Vurgu yalnızca video çalarken: duraklayınca ya da cümle bitince seçili kalmaz.
  const activeSent = useMemo(() => {
    if (!hasVideo || vs.videoId !== videoId || !vs.ready || !vs.playing) return null;
    let best: { segId: string; para: number; start: number; end: number; t: number } | null = null;
    for (const s of segments) {
      const lens = (paras.get(s.id) ?? []).map((p) => p.length);
      const r = sentenceAtTime(s.marks, lens, vs.time);
      if (!r) continue;
      const t = markTimeAt(s.marks, r.para, r.start) ?? 0;
      if (!best || t > best.t) best = { segId: s.id, ...r, t };
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vs.time, vs.ready, vs.playing, vs.videoId, hasVideo, segments, paras]);

  useEffect(() => {
    const close = (e: MouseEvent) => !procRef.current?.contains(e.target as Node) && setProcMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // Vurguya tek tık açıklama kartını açar; çift tıkla karışmasın diye kısa bir gecikmeyle açılır.
  const openTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(openTimer.current), []);
  const onMarkClick = (id: string, e: React.MouseEvent) => {
    window.clearTimeout(openTimer.current);
    if (e.detail > 1) return;
    openTimer.current = window.setTimeout(() => {
      if (!window.getSelection()?.toString()) setActiveId(id);
    }, 280);
  };

  // Metni çift tıklayınca o cümle çalar ve cümle bitince durur. Tek tık normal metin seçimi içindir.
  // Açıklama vurgulu cümlelerde de geçerlidir: kart açılmaz, video o cümleye gider.
  const onParaDoubleClick = (e: React.MouseEvent<HTMLParagraphElement>) => {
    const el = e.target as HTMLElement;
    const tAttr = el.closest<HTMLElement>("[data-t]")?.dataset.t;
    if (tAttr == null || !hasVideo) return;
    if (el.closest("mark.hl")) {
      window.clearTimeout(openTimer.current);
      setActiveId(null);
    }
    // Çift tık tarayıcıda kelime seçimi de başlatır; oynatma için bu seçimi ve balonu temizle.
    window.getSelection()?.removeAllRanges();
    setSel(null);
    const t = Number(tAttr);
    const segId = el.closest<HTMLElement>("p[data-seg]")?.dataset.seg;
    const marks = segments.find((s) => s.id === segId)?.marks;
    const end = marks?.find((m) => m.t > t)?.t ?? t + 25; // sonraki cümlenin başı; yoksa kısa bir pencere
    try {
      playAt(t, end);
    } catch (err: any) {
      onToast(`Video oynatılamadı: ${err?.message ?? err}`, "error");
    }
  };

  // Seçim balonu ekranın dışına taşmasın diye yatay konumu sınırlanır (üç düğme ~250px).
  const selLeft = sel ? Math.min(Math.max(sel.rect.left + sel.rect.width / 2, 130), window.innerWidth - 130) : 0;

  const contextOf = (i: Insight) => {
    const list = paras.get(i.segmentId) ?? [];
    return [list[i.para - 1], list[i.para], list[i.para + 1]].filter(Boolean).join("\n\n");
  };

  const active = source.insights.find((i) => i.id === activeId) ?? null;

  const closeCard = () => setActiveId(null);
  const removeInsight = (id: string) => {
    if (runRef.current?.id === id) runRef.current.cancel();
    onInsights(source.id, source.insights.filter((i) => i.id !== id));
    setActiveId(null);
    setLive(null);
  };

  // Aktif segment (içindekiler çubuğu) + kart konumunun yenilenmesi
  const onScroll = () => {
    setTick((t) => t + 1);
    const sc = scrollRef.current;
    if (!sc) return;
    const secs = Array.from(sc.querySelectorAll<HTMLElement>("section.seg"));
    const top = sc.getBoundingClientRect().top + 60;
    let idx = 0;
    secs.forEach((s, i) => {
      if (s.getBoundingClientRect().top <= top) idx = i;
    });
    setActiveSeg(idx);
  };

  const goto = (i: number) => {
    scrollRef.current?.querySelectorAll("section.seg")[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Akış sırasında en alta yapışık kal
  const stickRef = useRef(true);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (sc && busyHere && stickRef.current) sc.scrollTop = sc.scrollHeight;
  }, [segments, busyHere]);

  const anchorRect = active ? scrollRef.current?.querySelector(`[data-insight="${active.id}"]`)?.getBoundingClientRect() ?? null : null;
  void tick;

  const total = segments.reduce((n, s) => n + s.text.length + 1, 0) || 1;
  const pct = proc.progress ? Math.round((proc.progress.done / Math.max(1, proc.progress.total)) * 100) : 0;

  // Altyazı aşamasında geçen süre ve yt-dlp'nin anlık durumu (yeniden deneme vb.).
  const [note, setNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!proc.running) {
      setNote("");
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    let unlisten: (() => void) | undefined;
    let alive = true;
    onYtdlpStatus(setNote).then((f) => (alive ? (unlisten = f) : f()));
    return () => {
      alive = false;
      clearInterval(tick);
      unlisten?.();
    };
  }, [proc.running]);

  const busyElsewhere = proc.running && !mine;
  const hasContent = !!source.transcriptRaw || segments.length > 0;
  const showTabs = project.sources.length > 1 || !!source.url || hasContent;
  const history = source.history ?? [];
  const fmtTime = (t: number) => new Date(t).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const closeMenu = () => setProcMenu(false);

  return (
    <div className="pane left-pane" ref={paneRef}>
      <div className="pane-head">
        <span className="pane-title">Kaynak metin</span>
        {segments.length > 0 && (
          <button
            className={"btn small chat-toggle" + (chatOpen ? " on" : "")}
            onClick={() => toggleChat()}
            title="Bu metin hakkında AI'a soru sor"
          >
            ✦ Sor{(source.chat?.length ?? 0) > 0 ? ` (${Math.ceil((source.chat?.length ?? 0) / 2)})` : ""}
          </button>
        )}
        {segments.length > 0 && <button className="btn small" disabled={proc.running || queued} onClick={() => setEditOpen(true)}>Metin düzelt</button>}
        {busyHere ? (
          <>
            <span className="muted">
              {proc.phase === "transcript"
                ? `Altyazı çekiliyor… ${elapsed} sn`
                : proc.phase === "subs"
                  ? `Altyazı listesi alınıyor… ${elapsed} sn`
                  : `İşleniyor ${proc.progress?.done ?? 0}/${proc.progress?.total ?? "?"}`}
            </span>
            <button className="btn small" onClick={onCancel}>İptal</button>
          </>
        ) : queued ? (
          <>
            <span className="muted">Sırada: önceki işlem bitince başlayacak</span>
            <button className="btn small" onClick={onDequeue}>Sıradan çıkar</button>
          </>
        ) : busyElsewhere ? (
          <span className="muted">Başka bir kaynak işleniyor…</span>
        ) : (
          (hasContent || !!source.url) && (
            <div className="dropdown" ref={procRef}>
              <button className="btn small" onClick={() => setProcMenu(!procMenu)} title="Altyazıyı AI ile yeniden işle">
                Yeniden işle ▾
              </button>
              {procMenu && (
                <div className="menu right proc-menu">
                  {source.transcriptRaw && (
                    <button
                      onClick={() => {
                        closeMenu();
                        onReprocess();
                      }}
                    >
                      Yeniden işle <span className="muted">Varsayılan istemle</span>
                    </button>
                  )}
                  {segments.length > 0 && (
                    <button
                      onClick={() => {
                        closeMenu();
                        setCustomOpen(true);
                      }}
                    >
                      AI ile düzenle… <span className="muted">Mevcut metin + altyazı bağlamı + talimatın</span>
                    </button>
                  )}
                  {source.url.trim() && (
                    <button
                      onClick={() => {
                        closeMenu();
                        onPickSubtitle();
                      }}
                    >
                      Başka altyazı seç… <span className="muted">Videodaki diğer diller</span>
                    </button>
                  )}
                  {history.length > 0 && (
                    <>
                      <div className="menu-sep" />
                      <div className="menu-label muted">Önceki işlemeye dön</div>
                      {history.map((h, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            closeMenu();
                            onRestore(i);
                          }}
                          title={`${h.segments.length} bölüm`}
                        >
                          <span>{fmtTime(h.createdAt)}</span> <span className="muted">{h.label}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>
      {showTabs && (
        <div className="source-tabs" role="tablist">
          {project.sources.map((s, i) => (
            <div
              key={s.id}
              className={"source-tab" + (s.id === source.id ? " on" : "") + (proc.running && proc.sourceId === s.id ? " busy" : "")}
            >
              <button
                className="source-tab-btn"
                role="tab"
                aria-selected={s.id === source.id}
                title={s.url ? `${sourceLabel(s, i)}\n${s.url}` : sourceLabel(s, i)}
                onClick={() => onSelectSource(s.id)}
              >
                {sourceLabel(s, i)}
              </button>
              {(project.sources.length > 1 || s.url || s.transcriptRaw || s.segments.length > 0) && (
                <button className="source-tab-x" title="Kaynağı sil" aria-label="Kaynağı sil" onClick={() => onRemoveSource(s.id)}>
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            className="source-add"
            disabled={proc.running}
            title={proc.running ? "İşlem bitince yeni kaynak eklenebilir" : "Başka bir YouTube videosu ya da kendi metninizi kaynak olarak ekleyin"}
            onClick={() => setAdding((a) => !a)}
          >
            ＋ Kaynak
          </button>
        </div>
      )}
      {adding && (
        <div className="source-add-form">
          <SourceForm
            submitLabel="Ekle"
            autoFocus
            onUrl={(u, t) => {
              setAdding(false);
              onAddSource(u, t);
            }}
            onText={(text, t) => {
              setAdding(false);
              onAddTextSource(text, t);
            }}
          />
        </div>
      )}
      {busyHere && (proc.phase === "transcript" || proc.phase === "subs") && (
        <div className="ytdlp-note muted">{note || "İşlem başlatılıyor…"}</div>
      )}
      {busyHere && proc.phase === "ai" && (
        <div className="progress"><div style={{ width: `${Math.max(4, pct)}%` }} /></div>
      )}
      {proc.error && mine && (
        <div className="banner error">
          <span>{proc.error}</span>
          <span className="banner-actions">
            {proc.resumable && (
              <button className="btn small" onClick={onResume}>Kaldığı yerden devam et</button>
            )}
            {(source.transcriptRaw || source.url.trim()) && (
              <button className="btn small" onClick={onReprocess}>Yeniden dene</button>
            )}
          </span>
        </div>
      )}

      <div className="reader-wrap">
        {segments.length > 1 && (
          <nav className="toc">
            {segments.map((s, i) => (
              <button
                key={s.id}
                className={i === activeSeg ? "on" : ""}
                style={{ flexGrow: Math.max(1, ((s.text.length + 1) / total) * 100), background: segStyle(i, 1).stripe }}
                title={s.title}
                onClick={() => goto(i)}
              />
            ))}
          </nav>
        )}
        <div
          className="reader-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            onScroll();
          }}
        >
          <div className="reader-col">
            {segments.length === 0 && !busyHere && !queued && (
              <div className="empty start-empty">
                <p className="start-title">Henüz kaynak metin yok</p>
                <p className="muted">Bir YouTube bağlantısı yapıştırın (altyazı çekilip Türkçe'ye düzenlenir) ya da kendi metninizi olduğu gibi ekleyin.</p>
                <SourceForm
                  key={source.id}
                  initialUrl={source.url}
                  initialTitle={source.title}
                  submitLabel="Başlat"
                  onUrl={onFetchUrl}
                  onText={onFetchText}
                />
              </div>
            )}
            {segments.map((seg, i) => {
              const st = segStyle(i, settings.segmentTint);
              return (
                <section
                  key={seg.id}
                  className="seg"
                  data-segid={seg.id}
                  style={{ background: st.bg }}
                >
                  <div className="seg-label" style={{ color: st.label }}>
                    {seg.title}
                    <button
                      className="seg-mic"
                      onClick={() =>
                        window.dispatchEvent(new CustomEvent(VOICE_RECORD_EVENT, { detail: { sourceId: source.id, segmentId: seg.id, title: seg.title } }))
                      }
                      title="Bu bölümü kendi sözlerinle seslendir (ses kaydı başlatır)"
                      aria-label="Bu bölüm için ses kaydı al"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />
                      </svg>
                    </button>
                  </div>
                  {(paras.get(seg.id) ?? []).map((p, pi) => (
                    <p key={pi} data-seg={seg.id} data-para={pi} onDoubleClick={onParaDoubleClick}>
                      {renderPara(p, source.insights, onMarkClick, {
                        segId: seg.id,
                        para: pi,
                        marks: seg.marks,
                        cur:
                          activeSent && activeSent.segId === seg.id && activeSent.para === pi
                            ? { start: activeSent.start, end: activeSent.end }
                            : null,
                      })}
                    </p>
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      </div>

      {chatOpen && segments.length > 0 && (
        <>
          <div className="chat-divider" onPointerDown={startChatDrag} title="Sürükleyerek boyutlandır" />
          <div className="chat-wrap" style={{ height: `${chatH * 100}%` }}>
            <ChatPanel
              key={`${source.id}:${settings.aiProvider}`}
              title={source.title.trim() || project.title}
              segments={segments}
              messages={source.chat ?? []}
              settings={settings}
              models={models}
              quote={chatQuote}
              onClearQuote={() => setChatQuote(null)}
              onChange={(msgs) => onChat(source.id, msgs)}
              onClose={() => toggleChat(false)}
              onToast={onToast}
            />
          </div>
        </>
      )}

      {sel && (
        <div
          className="sel-pop"
          style={{ left: selLeft, top: Math.max(8, sel.rect.top - 40) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button onClick={() => addInsight("explain")}>✦ Açıkla</button>
          <button onClick={() => addInsight("factcheck")}>İddiayı doğrula</button>
          <button className="speak" onClick={askSel} title="Seçili metni alıntılayarak AI'a soru sor">Sor</button>
          {sel.quote.length <= SPEAK_MAX_CHARS && /\p{L}/u.test(sel.quote) && (
            <button className="speak" onClick={speakSel} title="Seçili metni dinle" aria-label="Seçili metni dinle">
              <SpeakIcon />
              <span>Seslendir</span>
            </button>
          )}
        </div>
      )}

      {editOpen && !proc.running && <TextEditDialog segments={source.segments} onApply={(next) => onEditText(source.id, next)} onClose={() => setEditOpen(false)} />}

      {customOpen && (
        <PromptDialog
          title="AI ile düzenle"
          hint="Mevcut metnin tamamı ve bağlam için ham altyazı AI’a gönderilir. Yazdığınız talimata göre mevcut metin düzenlenir. Önceki sürüm geçmişte saklanır. Ctrl+Enter ile gönderin."
          placeholder={CUSTOM_PROMPT_PLACEHOLDER}
          confirmLabel="Çalıştır"
          onCancel={() => setCustomOpen(false)}
          onSubmit={(prompt) => {
            setCustomOpen(false);
            onCustomRun(prompt);
          }}
        />
      )}

      {active && (
        <InsightCard
          insight={active}
          anchor={anchorRect}
          models={models}
          defaultModel={activeModel(settings, true)}
          live={live && live.id === active.id ? live : null}
          onClose={closeCard}
          onDelete={() => removeInsight(active.id)}
          onRerun={(model) => runInsight(active, model, contextOf(active))}
        />
      )}
    </div>
  );
}

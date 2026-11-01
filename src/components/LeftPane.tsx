import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, onYtdlpStatus, streamChat } from "../lib/api";
import { segStyle } from "../lib/colors";
import { buildInsightMessage } from "../lib/prompts";
import { audioRange, markTimeAt, paragraphsOf, sentenceAtTime } from "../lib/segmentParser";
import { speak } from "../lib/speech";
import { getAudioState, pauseOriginal, playAt, seekTo, stopOriginal, subscribeAudio } from "../lib/originalAudio";
import type { Insight, Project, Segment, SentenceMark, Settings } from "../lib/types";
import type { Progress } from "../lib/pipeline";
import { InsightCard } from "./InsightCard";
import { PromptDialog } from "./Dialogs";
import { SpeakIcon } from "./SpeakIcon";

/** Seslendirme tek seferde en fazla bu kadar karakteri okur (sağ panelle aynı sınır). */
const SPEAK_MAX_CHARS = 200;
import { CUSTOM_PROMPT_PLACEHOLDER } from "../lib/prompts";

export interface ProcState {
  running: boolean;
  phase: "transcript" | "ai" | null;
  progress: Progress | null;
  error: string | null;
  live: Segment[] | null;
}

interface Props {
  project: Project;
  settings: Settings;
  models: string[];
  proc: ProcState;
  onInsights: (insights: Insight[]) => void;
  onReprocess: () => void;
  onCustomRun: (prompt: string) => void;
  onCancel: () => void;
  onFetchUrl: (url: string, title?: string) => void;
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
function renderPara(text: string, insights: Insight[], onOpen: (id: string) => void, o: ParaOpts) {
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
        <mark className="hl" data-insight={ins.id} onClick={() => !window.getSelection()?.toString() && onOpen(ins.id)}>
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

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** `[dk:sn] metin` satırlarını (altyazı kaynağı, İngilizce) zamanlı listeye çevirir. */
function parseCues(raw: string | undefined): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const m = /^\[(\d{1,4}):(\d{2})\]\s*(.*)$/.exec(line.trim());
    if (m && m[3]) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3] });
  }
  return out;
}

/** Verilen zamanda çalan satırın metni (son başlangıcı geçmiş satır). */
function cueAt(cues: { t: number; text: string }[], time: number): string {
  let text = "";
  for (const c of cues) {
    if (c.t > time + 0.5) break;
    text = c.text;
  }
  return text;
}

export function LeftPane({ project, settings, models, proc, onInsights, onReprocess, onCustomRun, onCancel, onFetchUrl, onToast }: Props) {
  const segments = proc.live ?? project.segments;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; text: string; error?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [activeSeg, setActiveSeg] = useState(0);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const runRef = useRef<{ id: string; cancel: () => void } | null>(null);
  const insightsRef = useRef(project.insights);
  insightsRef.current = project.insights;

  const paras = useMemo(() => new Map(segments.map((s) => [s.id, paragraphsOf(s.text)])), [segments]);

  // Proje değişince açık kart/seçim kapanır.
  useEffect(() => {
    runRef.current?.cancel();
    stopOriginal();
    setActiveId(null);
    setSel(null);
    setLive(null);
  }, [project.id]);

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
      runRef.current?.cancel();
      const h = streamChat({
        baseUrl: settings.baseUrl,
        model,
        system: settings.insightPrompt,
        user: buildInsightMessage(insight.quote, context),
        temperature: settings.temperature,
        onText: (t) => setLive({ id: insight.id, text: t }),
      });
      runRef.current = { id: insight.id, cancel: h.cancel };
      setLive({ id: insight.id, text: "" });
      h.done
        .then((text) => {
          const res = { id: crypto.randomUUID(), model, text: text.trim(), createdAt: Date.now() };
          onInsights(insightsRef.current.map((i) => (i.id === insight.id ? { ...i, results: [...i.results, res] } : i)));
          setLive(null);
        })
        .catch((e) => {
          if (e.message === "İptal edildi") return;
          setLive({ id: insight.id, text: "", error: e.message });
        });
    },
    [settings, onInsights],
  );

  const explain = () => {
    if (!sel) return;
    if (!settings.model) return onToast("Önce Ayarlar'dan bir model seçin", "error");
    const insight: Insight = {
      id: crypto.randomUUID(),
      segmentId: sel.segmentId,
      para: sel.para,
      start: sel.start,
      end: sel.end,
      quote: sel.quote,
      results: [],
    };
    onInsights([...project.insights, insight]);
    insightsRef.current = [...insightsRef.current, insight];
    setActiveId(insight.id);
    window.getSelection()?.removeAllRanges();
    setSel(null);
    runInsight(insight, settings.insightModel || settings.model, sel.context);
  };

  // Seçili cümlenin orijinal sesi (zaman işaretleri varsa); yoksa seslendirme (TTS).
  const speakSel = () => {
    if (!sel) return;
    const range = audioRange(segments.find((s) => s.id === sel.segmentId)?.marks, sel);
    if (range && /^https?:\/\//.test(project.url)) {
      void playAt(project.id, project.url, range.from, range.to ?? range.from + 60).catch((e) =>
        onToast(`Orijinal ses çalınamadı: ${e?.message ?? e}`, "error"),
      );
      return;
    }
    void speak(sel.quote).then((ok) => ok || onToast("Ses çalınamadı (internet bağlantısını kontrol et)", "error"));
  };

  // Oynatıcı: sol paneldeki küçük çubuk ve çalan cümlenin vurgusu.
  const audio = useSyncExternalStore(subscribeAudio, getAudioState);
  const audioHere = audio.projectId === project.id && audio.status !== "idle";
  const hasTimes = segments.some((s) => s.marks?.length);
  const hasAudio = hasTimes && /^https?:\/\//.test(project.url);
  // Vurgu yalnızca ses çalarken: duraklayınca ya da cümle bitince seçili kalmaz.
  const activeSent = useMemo(() => {
    if (!audioHere || audio.status !== "ready" || !audio.playing) return null;
    let best: { segId: string; para: number; start: number; end: number; t: number } | null = null;
    for (const s of segments) {
      const lens = (paras.get(s.id) ?? []).map((p) => p.length);
      const r = sentenceAtTime(s.marks, lens, audio.time);
      if (!r) continue;
      const t = markTimeAt(s.marks, r.para, r.start) ?? 0;
      if (!best || t > best.t) best = { segId: s.id, ...r, t };
    }
    return best;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.time, audio.status, audio.playing, audioHere, segments, paras]);

  // Oynat: duraklatılmış/durmuş konumdan devam eder (cümle sonunda durduysa sonraki cümleden).
  const playerPlay = () => {
    if (audioHere && audio.playing) return pauseOriginal();
    const atEnd = audio.duration > 0 && audio.time >= audio.duration - 0.5;
    const from = audioHere && audio.status === "ready" && !atEnd ? audio.time : 0;
    playAt(project.id, project.url, from, null).catch((e) =>
      onToast(`Orijinal ses çalınamadı: ${e?.message ?? e}`, "error"),
    );
  };

  // Altyazı (İngilizce) satırları: oynatıcıda çalan cümlenin kaynağını yumuşakça göstermek için.
  const cues = useMemo(() => parseCues(project.transcriptRaw), [project.transcriptRaw]);
  const enLine = audioHere && audio.status === "ready" ? cueAt(cues, audio.time) : "";

  // Metni çift tıklayınca o cümle çalar ve cümle bitince durur. Tek tık normal metin seçimi içindir.
  const onParaDoubleClick = (e: React.MouseEvent<HTMLParagraphElement>) => {
    const el = e.target as HTMLElement;
    if (el.closest("mark.hl")) return;
    const tAttr = el.closest<HTMLElement>("[data-t]")?.dataset.t;
    if (tAttr == null || !hasAudio) return;
    // Çift tık tarayıcıda kelime seçimi de başlatır; oynatma için bu seçimi ve balonu temizle.
    window.getSelection()?.removeAllRanges();
    setSel(null);
    const t = Number(tAttr);
    const segId = el.closest<HTMLElement>("p[data-seg]")?.dataset.seg;
    const marks = segments.find((s) => s.id === segId)?.marks;
    const end = marks?.find((m) => m.t > t)?.t ?? t + 25; // sonraki cümlenin başı; yoksa kısa bir pencere
    playAt(project.id, project.url, t, end).catch((err) =>
      onToast(`Orijinal ses çalınamadı: ${err?.message ?? err}`, "error"),
    );
  };

  const openVideo = () => {
    api.openExternal(project.url).catch((e) => onToast(`Video açılamadı: ${e}`, "error"));
  };
  const hasVideo = /^https?:\/\//.test(project.url);

  // Seçim balonu ekranın dışına taşmasın diye yatay konumu sınırlanır (iki düğme ~170px).
  const selLeft = sel ? Math.min(Math.max(sel.rect.left + sel.rect.width / 2, 96), window.innerWidth - 96) : 0;

  const contextOf = (i: Insight) => {
    const list = paras.get(i.segmentId) ?? [];
    return [list[i.para - 1], list[i.para], list[i.para + 1]].filter(Boolean).join("\n\n");
  };

  const active = project.insights.find((i) => i.id === activeId) ?? null;

  const closeCard = () => setActiveId(null);
  const removeInsight = (id: string) => {
    if (runRef.current?.id === id) runRef.current.cancel();
    onInsights(project.insights.filter((i) => i.id !== id));
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
    if (sc && proc.running && stickRef.current) sc.scrollTop = sc.scrollHeight;
  }, [segments, proc.running]);

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

  return (
    <div className="pane left-pane">
      <div className="pane-head">
        <span className="pane-title">Kaynak metin</span>
        {hasVideo && (
          <button className="btn small video-link" onClick={openVideo} title={project.url}>
            ▶ Videoyu aç
          </button>
        )}
        {proc.running ? (
          <>
            <span className="muted">
              {proc.phase === "transcript"
                ? `Altyazı çekiliyor… ${elapsed} sn`
                : `İşleniyor ${proc.progress?.done ?? 0}/${proc.progress?.total ?? "?"}`}
            </span>
            <button className="btn small" onClick={onCancel}>İptal</button>
          </>
        ) : (
          <>
            {project.transcriptRaw && (
              <button className="btn small" onClick={onReprocess} title="Altyazıyı yeniden AI ile işle">
                Yeniden işle
              </button>
            )}
            {segments.length > 0 && (
              <button
                className="btn small"
                onClick={() => setCustomOpen(true)}
                title="Altyazıyı varsayılan istem, anlatım tarzı ve örneklerle birlikte, kendi isteminizin ek olarak uygulandığı şekilde yeniden işleyin"
              >
                Özel istemle işle
              </button>
            )}
          </>
        )}
      </div>
      {proc.running && proc.phase === "transcript" && (
        <div className="ytdlp-note muted">{note || "İşlem başlatılıyor…"}</div>
      )}
      {proc.running && proc.phase === "ai" && (
        <div className="progress"><div style={{ width: `${Math.max(4, pct)}%` }} /></div>
      )}
      {proc.error && (
        <div className="banner error">
          <span>{proc.error}</span>
          {project.transcriptRaw ? (
            <button className="btn small" onClick={onReprocess}>Yeniden dene</button>
          ) : null}
        </div>
      )}

      {hasAudio && (
        <div className="orig-bar">
          <button
            className={"orig-play" + (audioHere && audio.playing ? " on" : "")}
            onClick={playerPlay}
            disabled={audio.status === "loading"}
            title={audioHere && audio.playing ? "Duraklat" : "Oynat (kaldığı yerden)"}
            aria-label={audioHere && audio.playing ? "Duraklat" : "Oynat"}
          >
            {audio.status === "loading" ? "…" : audioHere && audio.playing ? "❚❚" : "▶"}
          </button>
          <div className="orig-main">
            <div className="orig-en" title={enLine}>
              {enLine || (audio.status === "loading" ? "Ses indiriliyor…" : "Orijinal ses")}
            </div>
            <input
              type="range"
              className="orig-seek"
              aria-label="Oynatma konumu"
              min={0}
              max={audioHere && audio.duration ? audio.duration : 1}
              step={0.1}
              value={audioHere ? Math.min(audio.time, audio.duration || audio.time) : 0}
              style={{ "--p": `${audioHere && audio.duration ? Math.min(100, (audio.time / audio.duration) * 100) : 0}%` } as React.CSSProperties}
              disabled={!audioHere || audio.status !== "ready"}
              onChange={(e) => seekTo(Number(e.target.value))}
            />
          </div>
          <span className="orig-time">
            {fmtClock(audioHere ? audio.time : 0)} / {fmtClock(audioHere ? audio.duration : 0)}
          </span>
          {audioHere && audio.error && <span className="orig-err">{audio.error}</span>}
          {audioHere && (
            <button className="orig-close" onClick={stopOriginal} title="Oynatıcıyı kapat" aria-label="Oynatıcıyı kapat">✕</button>
          )}
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
            {segments.length === 0 && !proc.running && (
              <div className="empty start-empty">
                <p className="start-title">Henüz kaynak metin yok</p>
                <p className="muted">Bir YouTube bağlantısı yapıştırın; altyazı çekilip Türkçe'ye düzenlenecek.</p>
                <div className="link-start">
                  <input
                    className="input"
                    placeholder="https://www.youtube.com/watch?v=…"
                    spellCheck={false}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && url.trim() && onFetchUrl(url.trim(), title)}
                  />
                  <input
                    className="input"
                    placeholder="Başlık (isteğe bağlı)"
                    spellCheck={false}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && url.trim() && onFetchUrl(url.trim(), title)}
                  />
                  <button className="btn primary" disabled={!url.trim()} onClick={() => onFetchUrl(url.trim(), title)}>
                    Başlat
                  </button>
                </div>
              </div>
            )}
            {segments.map((seg, i) => {
              const st = segStyle(i, settings.segmentTint);
              return (
                <section
                  key={seg.id}
                  className="seg"
                  style={{ background: st.bg }}
                >
                  <div className="seg-label" style={{ color: st.label }}>{seg.title}</div>
                  {(paras.get(seg.id) ?? []).map((p, pi) => (
                    <p key={pi} data-seg={seg.id} data-para={pi} onDoubleClick={onParaDoubleClick}>
                      {renderPara(p, project.insights, setActiveId, {
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

      {sel && (
        <div
          className="sel-pop"
          style={{ left: selLeft, top: Math.max(8, sel.rect.top - 40) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button onClick={explain}>✦ Açıkla</button>
          {sel.quote.length <= SPEAK_MAX_CHARS && /\p{L}/u.test(sel.quote) && (
            <button className="speak" onClick={speakSel} title="Seçili metni dinle" aria-label="Seçili metni dinle">
              <SpeakIcon />
              <span>Seslendir</span>
            </button>
          )}
        </div>
      )}

      {customOpen && (
        <PromptDialog
          title="Özel istemle işle"
          hint="Altyazı, ayarlardaki sistem istemi, anlatım tarzı ve örnek çiftleriyle birlikte yeniden işlenir; yazdığınız istem bunların üstüne ek talimat olarak eklenir. Mevcut bölümler ve açıklama vurguları yenilenir. Ctrl+Enter ile çalıştırabilirsiniz."
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
          defaultModel={settings.insightModel || settings.model}
          live={live && live.id === active.id ? live : null}
          onClose={closeCard}
          onDelete={() => removeInsight(active.id)}
          onRerun={(model) => runInsight(active, model, contextOf(active))}
        />
      )}
    </div>
  );
}

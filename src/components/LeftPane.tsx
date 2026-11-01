import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, streamChat } from "../lib/api";
import { segStyle } from "../lib/colors";
import { buildInsightMessage } from "../lib/prompts";
import { paragraphsOf } from "../lib/segmentParser";
import { speak } from "../lib/speech";
import type { Insight, Project, Segment, Settings } from "../lib/types";
import type { Progress } from "../lib/pipeline";
import { InsightCard } from "./InsightCard";
import { SpeakIcon } from "./SpeakIcon";

/** Seslendirme tek seferde en fazla bu kadar karakteri okur (sağ panelle aynı sınır). */
const SPEAK_MAX_CHARS = 200;

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
  onCancel: () => void;
  onFetchUrl: (url: string) => void;
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

function renderPara(text: string, segId: string, para: number, insights: Insight[], onOpen: (id: string) => void) {
  const list = insights
    .filter((i) => i.segmentId === segId && i.para === para)
    .sort((a, b) => a.start - b.start);
  if (!list.length) return text;
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const ins of list) {
    if (ins.start < pos || ins.end > text.length || ins.end <= ins.start) continue;
    if (ins.start > pos) out.push(text.slice(pos, ins.start));
    out.push(
      <mark key={ins.id} className="hl" data-insight={ins.id} onClick={() => !window.getSelection()?.toString() && onOpen(ins.id)}>
        {text.slice(ins.start, ins.end)}
      </mark>,
    );
    pos = ins.end;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

export function LeftPane({ project, settings, models, proc, onInsights, onReprocess, onCancel, onFetchUrl, onToast }: Props) {
  const segments = proc.live ?? project.segments;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<{ id: string; text: string; error?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [activeSeg, setActiveSeg] = useState(0);
  const [url, setUrl] = useState("");
  const runRef = useRef<{ id: string; cancel: () => void } | null>(null);
  const insightsRef = useRef(project.insights);
  insightsRef.current = project.insights;

  const paras = useMemo(() => new Map(segments.map((s) => [s.id, paragraphsOf(s.text)])), [segments]);

  // Proje değişince açık kart/seçim kapanır.
  useEffect(() => {
    runRef.current?.cancel();
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

  const speakSel = () => {
    if (!sel) return;
    void speak(sel.quote).then((ok) => ok || onToast("Ses çalınamadı (internet bağlantısını kontrol et)", "error"));
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
              {proc.phase === "transcript" ? "Altyazı çekiliyor…" : `İşleniyor ${proc.progress?.done ?? 0}/${proc.progress?.total ?? "?"}`}
            </span>
            <button className="btn small" onClick={onCancel}>İptal</button>
          </>
        ) : (
          project.transcriptRaw && (
            <button className="btn small" onClick={onReprocess} title="Altyazıyı yeniden AI ile işle">
              Yeniden işle
            </button>
          )
        )}
      </div>
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
                    onKeyDown={(e) => e.key === "Enter" && url.trim() && onFetchUrl(url.trim())}
                  />
                  <button className="btn primary" disabled={!url.trim()} onClick={() => onFetchUrl(url.trim())}>
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
                    <p key={pi} data-seg={seg.id} data-para={pi}>
                      {renderPara(p, seg.id, pi, project.insights, setActiveId)}
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

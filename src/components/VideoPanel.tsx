import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { translatedSentenceAt } from "../lib/segmentParser";
import type { Segment } from "../lib/types";
import { attachFrame, getVideoState, pauseVideo, playAt, seekTo, setRate, subscribeVideo, videoIdOf } from "../lib/youtube";
import { FrameViewer } from "./FrameViewer";

interface Meta {
  title: string;
  description: string;
  channel: string;
  chapters: { title: string; start: number }[];
}

// Açıklamalar yt-dlp ile bir kez alınır; oturum boyunca bellekte tutulur.
const metaCache = new Map<string, Meta>();
function Icon({ d, w = 2, fill = false }: { d: string; w?: number; fill?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const CUE_KEY = "sa.cueLang";

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/** `[dk:sn] metin` satırlarını (altyazı kaynağı) zamanlı listeye çevirir. */
function parseCues(raw: string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const line of raw.split("\n")) {
    const m = /^\[(\d{1,4}):(\d{2})\]\s*(.*)$/.exec(line.trim());
    if (m && m[3]) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3] });
  }
  return out;
}

interface Props {
  url: string;
  title: string;
  /** Cümle başlangıç zamanları (sn, sıralı); önceki/sonraki cümle düğmeleri için. */
  marks: number[];
  /** `[dk:sn] metin` biçimli orijinal altyazı; çalan satırı göstermek için. */
  transcriptRaw: string;
  /** Orijinal altyazının dil kodu (bilinmiyorsa boş). */
  origLang: string;
  /** Çevrilmiş bölümler (cümle zaman işaretleriyle); altyazı kutusunda Türkçe göstermek için. */
  segments: Segment[];
  onToast: (msg: string, kind?: "error" | "info") => void;
}

/** Orta panel: gömülü YouTube videosu, oynatma kontrolleri, canlı altyazı, bölümler ve video bilgisi. */
export function VideoPanel({ url, title, marks, transcriptRaw, origLang, segments, onToast }: Props) {
  const id = videoIdOf(url);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [meta, setMeta] = useState<Meta | null>(id ? metaCache.get(id) ?? null : null);
  const [open, setOpen] = useState(false);
  const [rate, setRateState] = useState(1);
  const [shot, setShot] = useState<number | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  const rateRef = useRef<HTMLDivElement>(null);
  const [cueLang, setCueLang] = useState<"orig" | "tr">(() => (localStorage.getItem(CUE_KEY) === "tr" ? "tr" : "orig"));
  const hasTr = segments.some((s) => s.marks?.length);
  const showTr = cueLang === "tr" && hasTr;
  const vs = useSyncExternalStore(subscribeVideo, getVideoState);
  const cues = useMemo(() => parseCues(transcriptRaw), [transcriptRaw]);

  useEffect(() => {
    const f = frameRef.current;
    if (!f || !id) return;
    setRateState(1);
    return attachFrame(f, id);
  }, [id]);

  useEffect(() => {
    if (!rateOpen) return;
    const close = (e: MouseEvent) => !rateRef.current?.contains(e.target as Node) && setRateOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setRateOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [rateOpen]);

  useEffect(() => {
    setOpen(false);
    if (!id) return;
    const cached = metaCache.get(id);
    if (cached) return setMeta(cached);
    setMeta(null);
    let alive = true;
    api
      .videoMeta(url)
      .then((m) => {
        metaCache.set(id, m);
        if (alive) setMeta(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, url]);

  if (!id) return null;
  const ready = vs.ready && vs.videoId === id;
  const time = ready ? vs.time : 0;

  // Cümle gezinmesi: çalan/duraklayan konuma göre önceki, bu ve sonraki cümle.
  const idx = marks.reduce((k, t, i) => (t <= time + 0.05 ? i : k), -1);
  const playSentence = (i: number) => {
    if (i < 0 || i >= marks.length) return;
    try {
      playAt(marks[i], marks[i + 1] ?? marks[i] + 25);
    } catch (e: any) {
      onToast(`Video oynatılamadı: ${e?.message ?? e}`, "error");
    }
  };
  const toggle = () => {
    if (vs.playing) return pauseVideo();
    try {
      playAt(time);
    } catch (e: any) {
      onToast(`Video oynatılamadı: ${e?.message ?? e}`, "error");
    }
  };
  const closeShot = () => setShot(null);
  const openShot = () => {
    if (vs.playing) pauseVideo();
    setShot(time);
  };
  const pickRate = (r: number) => {
    setRateState(r);
    setRate(r);
    setRateOpen(false);
  };
  const toggleCueLang = () => {
    const next = cueLang === "tr" ? "orig" : "tr";
    setCueLang(next);
    localStorage.setItem(CUE_KEY, next);
  };

  const playing = ready && vs.playing;
  const cue = !playing
    ? ""
    : showTr
      ? translatedSentenceAt(segments, time + 0.3)
      : (cues.filter((c) => c.t <= time + 0.5).pop()?.text ?? "");
  const origTag = (origLang.split("-")[0] || "EN").toUpperCase().slice(0, 3);
  const origin = encodeURIComponent(window.location.origin);
  const src = `https://www.youtube.com/embed/${id}?enablejsapi=1&controls=0&rel=0&modestbranding=1&iv_load_policy=3&fs=0&disablekb=1&playsinline=1&origin=${origin}`;
  const desc = meta?.description.trim() ?? "";
  const chapters = meta?.chapters ?? [];
  const curChapter = chapters.reduce((k, c, i) => (c.start <= time + 0.5 ? i : k), -1);

  return (
    <div className="pane video-pane">
      <div className="pane-head">
        <span className="pane-title">Video</span>
      </div>
      <div className="video-scroll">
        <div className="video-frame">
          <iframe
            ref={frameRef}
            src={src}
            title="YouTube videosu"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
        {vs.error && (
          <div className="banner error">
            <span>{vs.error}</span>
            <button className="btn small" onClick={() => api.openExternal(url)}>Tarayıcıda aç</button>
          </div>
        )}

        <div className="vp-seek">
          <span className="vp-time">{clock(time)}</span>
          <input
            type="range"
            aria-label="Video konumu"
            min={0}
            max={vs.duration || 1}
            step={0.5}
            value={Math.min(time, vs.duration || time)}
            disabled={!ready || !vs.duration}
            style={{ "--p": `${vs.duration ? Math.min(100, (time / vs.duration) * 100) : 0}%` } as React.CSSProperties}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          <span className="vp-time">{clock(vs.duration)}</span>
        </div>
        <div className="vp-controls">
          <div className="vp-group">
            <button className="vp-btn" onClick={() => playSentence(idx >= 0 && time - marks[idx] > 1.5 ? idx : idx - 1)} disabled={!ready || !marks.length} title="Önceki cümle" aria-label="Önceki cümle">
              <Icon d="M19 20 9 12l10-8v16ZM5 4v16" />
            </button>
            <button className="vp-btn" onClick={() => playSentence(Math.max(idx, 0))} disabled={!ready || !marks.length} title="Bu cümleyi tekrar oynat" aria-label="Bu cümleyi tekrar oynat">
              <Icon d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />
            </button>
            <button className="vp-btn main" onClick={toggle} disabled={!ready} title={vs.playing ? "Duraklat" : "Oynat"} aria-label={vs.playing ? "Duraklat" : "Oynat"}>
              {vs.playing ? <Icon d="M7 4v16M17 4v16" w={3} /> : <Icon d="M7 4.5v15l13-7.5-13-7.5Z" fill />}
            </button>
            <button className="vp-btn" onClick={() => playSentence(idx + 1)} disabled={!ready || !marks.length} title="Sonraki cümle" aria-label="Sonraki cümle">
              <Icon d="m5 4 10 8-10 8V4ZM19 4v16" />
            </button>
          </div>
          <div className="vp-group">
            <button className="vp-btn" onClick={openShot} disabled={!ready} title="Bu anın karesini tam ekran göster (ekran görüntüsü için)" aria-label="Kareyi tam ekran göster">
              <Icon d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            </button>
            <span className="vp-sep" />
            <div className="vp-rate" ref={rateRef}>
              <button
                className={"vp-rate-btn" + (rate !== 1 ? " on" : "") + (rateOpen ? " open" : "")}
                onClick={() => setRateOpen(!rateOpen)}
                disabled={!ready}
                title="Oynatma hızı"
                aria-haspopup="menu"
                aria-expanded={rateOpen}
              >
                {rate}×
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {rateOpen && (
                <div className="vp-rate-menu" role="menu" aria-label="Oynatma hızı">
                  {RATES.map((r) => (
                    <button key={r} role="menuitemradio" aria-checked={r === rate} className={r === rate ? "on" : ""} onClick={() => pickRate(r)}>
                      {r === 1 ? "Normal" : `${r}×`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={"vp-cue" + (cue ? " live" : "")}>
          <button
            className={"vp-cue-tag" + (showTr ? " tr" : "")}
            onClick={toggleCueLang}
            disabled={!hasTr}
            title={
              hasTr
                ? showTr
                  ? "Türkçe çeviri gösteriliyor; orijinal altyazıya geçmek için tıkla"
                  : "Orijinal altyazı gösteriliyor; Türkçe çeviriye geçmek için tıkla"
                : "Türkçe için soldaki metnin zaman işaretli işlenmesi gerekir"
            }
          >
            {showTr ? "TR" : origTag}
          </button>
          <span className="vp-cue-text">
            {cue ||
              (!ready
                ? "Video yükleniyor…"
                : showTr
                  ? "Video çalarken Türkçe çeviri burada görünür"
                  : "Video çalarken orijinal altyazı burada görünür")}
          </span>
        </div>

        <div className="video-info">
          <div className="video-head">
            <button
              className="video-thumb-btn"
              onClick={() => api.openExternal(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`)}
              title="Kapak resmini HD olarak tarayıcıda aç"
            >
              <img className="video-thumb" src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" draggable={false} />
            </button>
            <div className="video-head-text">
              <div className="video-title">{meta?.title || title}</div>
              {meta?.channel && <div className="video-channel muted">{meta.channel}</div>}
            </div>
          </div>
          {chapters.length > 0 && (
            <div className="vp-chapters">
              <div className="vp-sub">Bölümler</div>
              {chapters.map((c, i) => (
                <button
                  key={i}
                  className={i === curChapter ? "on" : ""}
                  onClick={() => {
                    try {
                      playAt(c.start);
                    } catch (e: any) {
                      onToast(`Video oynatılamadı: ${e?.message ?? e}`, "error");
                    }
                  }}
                >
                  <span className="vp-ch-t">{clock(c.start)}</span>
                  <span className="vp-ch-n">{c.title}</span>
                </button>
              ))}
            </div>
          )}
          {desc && (
            <div className="video-desc">
              <div className={"video-desc-text" + (open ? " open" : "")}>{desc}</div>
              <button className="video-desc-toggle" onClick={() => setOpen(!open)}>{open ? "Daralt" : "Devamını göster"}</button>
            </div>
          )}
        </div>
      </div>
      <FrameViewer videoId={id} url={url} open={shot != null} target={shot ?? (ready && !vs.playing ? time : null)} onClose={closeShot} />
    </div>
  );
}

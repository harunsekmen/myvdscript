import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
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

const RATES = [0.75, 1, 1.25, 1.5, 2];

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
  onToast: (msg: string, kind?: "error" | "info") => void;
}

/** Orta panel: gömülü YouTube videosu, oynatma kontrolleri, canlı altyazı, bölümler ve video bilgisi. */
export function VideoPanel({ url, title, marks, transcriptRaw, onToast }: Props) {
  const id = videoIdOf(url);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [meta, setMeta] = useState<Meta | null>(id ? metaCache.get(id) ?? null : null);
  const [open, setOpen] = useState(false);
  const [rate, setRateState] = useState(1);
  const [shot, setShot] = useState<number | null>(null);
  const vs = useSyncExternalStore(subscribeVideo, getVideoState);
  const cues = useMemo(() => parseCues(transcriptRaw), [transcriptRaw]);

  useEffect(() => {
    const f = frameRef.current;
    if (!f || !id) return;
    setRateState(1);
    return attachFrame(f, id);
  }, [id]);

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
  };

  const cue = ready && vs.playing ? (cues.filter((c) => c.t <= time + 0.5).pop()?.text ?? "") : "";
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
          </div>
          <div className="vp-rates" role="group" aria-label="Oynatma hızı">
            {RATES.map((r) => (
              <button key={r} className={r === rate ? "on" : ""} onClick={() => pickRate(r)} disabled={!ready}>{r}×</button>
            ))}
          </div>
        </div>
        <div className={"vp-cue" + (cue ? " live" : "")}>
          <span className="vp-cue-tag">EN</span>
          <span className="vp-cue-text">{cue || (ready ? "Video çalarken orijinal altyazı burada görünür" : "Video yükleniyor…")}</span>
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

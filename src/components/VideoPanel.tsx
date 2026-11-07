import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { attachFrame, getVideoState, pauseVideo, playAt, setRate, subscribeVideo, videoIdOf } from "../lib/youtube";

interface Meta {
  title: string;
  description: string;
  channel: string;
  chapters: { title: string; start: number }[];
}

// Açıklamalar yt-dlp ile bir kez alınır; oturum boyunca bellekte tutulur.
const metaCache = new Map<string, Meta>();
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
  const [copied, setCopied] = useState(false);
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
  const pickRate = (r: number) => {
    setRateState(r);
    setRate(r);
  };
  const copyLink = async () => {
    try {
      await writeText(`https://youtu.be/${id}?t=${Math.floor(time)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      onToast(`Kopyalanamadı: ${e}`, "error");
    }
  };

  const cue = ready && vs.playing ? (cues.filter((c) => c.t <= time + 0.5).pop()?.text ?? "") : "";
  const origin = encodeURIComponent(window.location.origin);
  const src = `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0&playsinline=1&origin=${origin}`;
  const desc = meta?.description.trim() ?? "";
  const chapters = meta?.chapters ?? [];
  const curChapter = chapters.reduce((k, c, i) => (c.start <= time + 0.5 ? i : k), -1);

  return (
    <div className="pane video-pane">
      <div className="pane-head">
        <span className="pane-title">Video</span>
        <span className="spacer" />
        <button className="btn small" onClick={copyLink} disabled={!ready} title="Videonun şu anki konumunun bağlantısını kopyala">
          {copied ? "Kopyalandı ✓" : `🔗 ${clock(time)} bağlantısı`}
        </button>
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

        <div className="vp-controls">
          <button className="vp-btn" onClick={() => playSentence(idx >= 0 && time - marks[idx] > 1.5 ? idx : idx - 1)} disabled={!ready || !marks.length} title="Önceki cümle">⏮</button>
          <button className="vp-btn" onClick={() => playSentence(Math.max(idx, 0))} disabled={!ready || !marks.length} title="Bu cümleyi tekrar oynat">↻</button>
          <button className="vp-btn main" onClick={toggle} disabled={!ready} title={vs.playing ? "Duraklat" : "Oynat"}>{vs.playing ? "❚❚" : "▶"}</button>
          <button className="vp-btn" onClick={() => playSentence(idx + 1)} disabled={!ready || !marks.length} title="Sonraki cümle">⏭</button>
          <span className="spacer" />
          <div className="vp-rates" role="group" aria-label="Oynatma hızı">
            {RATES.map((r) => (
              <button key={r} className={r === rate ? "on" : ""} onClick={() => pickRate(r)} disabled={!ready}>{r}×</button>
            ))}
          </div>
        </div>
        <div className="vp-cue">{cue || (ready ? "Çalarken orijinal altyazı burada görünür" : "Video yükleniyor…")}</div>

        <div className="video-info">
          <div className="video-head">
            <img className="video-thumb" src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" draggable={false} />
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
          <button className="btn small video-ext" onClick={() => api.openExternal(url)}>YouTube'da aç ↗</button>
        </div>
      </div>
    </div>
  );
}

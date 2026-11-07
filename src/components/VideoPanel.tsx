import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { attachFrame, getVideoState, subscribeVideo, videoIdOf } from "../lib/youtube";

interface Meta {
  title: string;
  description: string;
  channel: string;
}

// Açıklamalar yt-dlp ile bir kez alınır; oturum boyunca bellekte tutulur.
const metaCache = new Map<string, Meta>();

/** Orta panel: gömülü YouTube videosu (genişliğe uyar) + kapak resmi, başlık, daraltılmış açıklama. */
export function VideoPanel({ url, title }: { url: string; title: string }) {
  const id = videoIdOf(url);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [meta, setMeta] = useState<Meta | null>(id ? metaCache.get(id) ?? null : null);
  const [open, setOpen] = useState(false);
  const vs = useSyncExternalStore(subscribeVideo, getVideoState);

  useEffect(() => {
    const f = frameRef.current;
    if (!f || !id) return;
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
  const origin = encodeURIComponent(window.location.origin);
  const src = `https://www.youtube.com/embed/${id}?enablejsapi=1&rel=0&playsinline=1&origin=${origin}`;
  const desc = meta?.description.trim() ?? "";

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
        <div className="video-info">
          <div className="video-head">
            <img className="video-thumb" src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" draggable={false} />
            <div className="video-head-text">
              <div className="video-title">{meta?.title || title}</div>
              {meta?.channel && <div className="video-channel muted">{meta.channel}</div>}
            </div>
          </div>
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

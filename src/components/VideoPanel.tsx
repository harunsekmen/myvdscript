import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, streamChat } from "../lib/api";
import { buildChapterMessage, CHAPTER_PROMPT, parseChapterTitles, sameTitles } from "../lib/chapters";
import { translatedSentenceAt } from "../lib/segmentParser";
import type { Segment, Settings } from "../lib/types";
import { attachFrame, getVideoState, pauseVideo, playAt, resumeVideo, seekTo, setRate, setVolume, subscribeVideo, toggleMute, videoIdOf } from "../lib/youtube";
import { FrameViewer } from "./FrameViewer";
import { claimKeys } from "../lib/keyScope";

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

/** Ses düğmesi: tıklayınca sessiz/sesli; üstüne gelince yanında ses çubuğu açılır. */
function VolumeControl({ volume, muted, disabled }: { volume: number; muted: boolean; disabled?: boolean }) {
  const v = muted ? 0 : volume;
  const icon =
    v === 0
      ? "M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6"
      : v < 50
        ? "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7"
        : "M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14";
  return (
    <div className={"vp-vol" + (disabled ? " off" : "")}>
      <button
        className="vp-btn"
        onClick={toggleMute}
        disabled={disabled}
        title={v === 0 ? "Sesi aç" : "Sesi kapat"}
        aria-label={v === 0 ? "Sesi aç" : "Sesi kapat"}
      >
        <Icon d={icon} />
      </button>
      <input
        type="range"
        className="vp-vol-range"
        aria-label="Ses seviyesi"
        title={`Ses: ${v}%`}
        min={0}
        max={100}
        step={1}
        value={v}
        disabled={disabled}
        style={{ "--p": `${v}%` } as React.CSSProperties}
        onChange={(e) => setVolume(Number(e.target.value))}
      />
    </div>
  );
}

const SEEK_STEP = 5;
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
  /** Kayıtlı bölüm başlığı çevirisi ve kaydetme. */
  chaptersTr?: { src: string[]; tr: string[] };
  onChaptersTr: (v: { src: string[]; tr: string[] }) => void;
  settings: Settings;
  onToast: (msg: string, kind?: "error" | "info") => void;
}

/** Orta panel: gömülü YouTube videosu, oynatma kontrolleri, canlı altyazı, bölümler ve video bilgisi. */
export function VideoPanel({ url, title, marks, transcriptRaw, origLang, segments, chaptersTr, onChaptersTr, settings, onToast }: Props) {
  const id = videoIdOf(url);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [embedBase, setEmbedBase] = useState<string>();
  const [meta, setMeta] = useState<Meta | null>(id ? metaCache.get(id) ?? null : null);
  const [open, setOpen] = useState(false);
  const [rate, setRateState] = useState(1);
  const [shot, setShot] = useState<number | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  const rateRef = useRef<HTMLDivElement>(null);
  const [cueLang, setCueLang] = useState<"orig" | "tr">(() => (localStorage.getItem(CUE_KEY) === "tr" ? "tr" : "orig"));
  const hasTr = segments.some((s) => s.marks?.length);
  const showTr = cueLang === "tr" && hasTr;
  const [fs, setFs] = useState(false);
  const [chTrBusy, setChTrBusy] = useState(false);
  const vs = useSyncExternalStore(subscribeVideo, getVideoState);
  const cues = useMemo(() => parseCues(transcriptRaw), [transcriptRaw]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);

  useEffect(() => {
    // macOS WebKit does not send an HTTP referrer from the packaged tauri:// page.
    if (window.location.protocol === "tauri:") {
      api.youtubeEmbedBase().then(setEmbedBase).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const f = frameRef.current;
    if (!f || !id) return;
    setRateState(1);
    return attachFrame(f, id);
  }, [id, embedBase]);

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

  // Bölüm başlıkları gelince (kayıtlı çevirisi yoksa) AI ile bir kez Türkçeleştirilir ve kaynağa kaydedilir.
  const chapterTitles = useMemo(() => (meta?.chapters ?? []).map((c) => c.title), [meta]);
  const trTitles = sameTitles(chaptersTr?.src, chapterTitles) ? chaptersTr!.tr : null;
  const onChTrRef = useRef(onChaptersTr);
  onChTrRef.current = onChaptersTr;
  useEffect(() => {
    if (!chapterTitles.length || trTitles || !settings.model) return;
    let alive = true;
    setChTrBusy(true);
    const h = streamChat({
      baseUrl: settings.baseUrl,
      model: settings.insightModel || settings.model,
      system: CHAPTER_PROMPT,
      user: buildChapterMessage(chapterTitles),
      temperature: 0.2,
    });
    h.done
      .then((text) => {
        const tr = parseChapterTitles(text, chapterTitles.length);
        if (tr) onChTrRef.current({ src: chapterTitles, tr });
      })
      .catch(() => {})
      .finally(() => alive && setChTrBusy(false));
    return () => {
      alive = false;
      h.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterTitles, !!trTitles, settings.model, settings.insightModel, settings.baseUrl]);

  // Tam ekran: video kutusu pencereyi kaplar ve pencere de tam ekran olur (iframe yeniden yüklenmez).
  useEffect(() => {
    if (!fs) return;
    const win = getCurrentWindow();
    let was = false;
    win
      .isFullscreen()
      .then((f) => {
        was = f;
        if (!f) return win.setFullscreen(true);
      })
      .catch(() => {});
    const key = (e: KeyboardEvent) => e.key === "Escape" && setFs(false);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      if (!was) win.setFullscreen(false).catch(() => {});
    };
  }, [fs]);

  const shotOpen = shot != null;
  // Klavye sahipliği: tam ekranda tüm kısayollar videonundur; video odaktayken / fare üzerindeyken
  // Boşluk ve oklar videoya gider (ses kayıtları paneli bunları almaz).
  const fsRef = useRef(fs);
  fsRef.current = fs;
  useEffect(
    () =>
      claimKeys(() => {
        if (fsRef.current) return "exclusive";
        if (!frameRef.current) return null;
        return document.activeElement === overlayRef.current || hoverRef.current ? "local" : null;
      }),
    [],
  );

  // Sol/sağ ok: video üzerindeyken, videoya tıklanmışken veya tam ekrandayken 5 sn geri/ileri sarar.
  // Boşluk: aynı durumlarda oynat/duraklat.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const space = e.key === " " || e.code === "Space";
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && !space) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || shotOpen) return;
      const t = e.target as HTMLElement | null;
      if (t?.classList.contains("vp-vol-range")) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && !t.closest(".vf-bar")) return;
      // Tam ekrandaki denetim çubuğunda odaklı düğmeye Boşluk basmak düğmeyi de tetikler; iki kez çalışmasın.
      if (space && t instanceof HTMLButtonElement && t.closest(".video-frame")) return;
      const focused = document.activeElement === overlayRef.current;
      if (!fs && !focused && !hoverRef.current) return;
      const s = getVideoState();
      if (!s.ready || s.videoId !== id) return;
      e.preventDefault();
      if (space) {
        if (e.repeat) return;
        if (s.playing) pauseVideo();
        else {
          try {
            resumeVideo();
          } catch {
            /* oynatıcı hazır değil */
          }
        }
        return;
      }
      const d = e.key === "ArrowLeft" ? -SEEK_STEP : SEEK_STEP;
      seekTo(Math.min(s.duration || Infinity, Math.max(0, s.time + d)));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [fs, id, shotOpen]);

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
      resumeVideo();
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
  const openOnYoutube = () => api.openExternal(`https://www.youtube.com/watch?v=${id}${time > 1 ? `&t=${Math.floor(time)}s` : ""}`);
  const toggleCueLang = () => {
    const next = cueLang === "tr" ? "orig" : "tr";
    setCueLang(next);
    localStorage.setItem(CUE_KEY, next);
  };

  const playing = ready && vs.playing;
  // Çalan satır; tam ekranda video duraklayınca da ekranda kalır (alttaki kutu yalnız çalarken gösterir).
  const liveCue = !ready || (!playing && time <= 0)
    ? ""
    : showTr
      ? translatedSentenceAt(segments, time + 0.3)
      : (cues.filter((c) => c.t <= time + 0.5).pop()?.text ?? "");
  const cue = playing ? liveCue : "";
  const origTag = (origLang.split("-")[0] || "EN").toUpperCase().slice(0, 3);
  const origin = encodeURIComponent(window.location.origin);
  const src = embedBase
    ? embedBase + encodeURIComponent(id)
    : `https://www.youtube.com/embed/${id}?enablejsapi=1&controls=0&rel=0&modestbranding=1&iv_load_policy=3&fs=0&disablekb=1&cc_load_policy=3&playsinline=1&origin=${origin}`;
  const desc = meta?.description.trim() ?? "";
  const chapters = meta?.chapters ?? [];
  const curChapter = chapters.reduce((k, c, i) => (c.start <= time + 0.5 ? i : k), -1);

  return (
    <div className="pane video-pane">
      <div className="pane-head">
        <span className="pane-title">Video</span>
      </div>
      <div className="video-scroll">
        <div className={"video-frame" + (fs ? " fs" : "")}>
          <iframe
            ref={frameRef}
            src={src}
            title="YouTube videosu"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
          {/* Tıklamaları yakalar: iframe odak almaz, böylece ok tuşlarıyla ileri/geri sarma çalışır. */}
          <div
            ref={overlayRef}
            className="vf-click"
            tabIndex={-1}
            onMouseEnter={() => (hoverRef.current = true)}
            onMouseLeave={() => (hoverRef.current = false)}
            onClick={() => {
              overlayRef.current?.focus({ preventScroll: true });
              if (ready) toggle();
            }}
            onDoubleClick={() => ready && setFs(!fs)}
          />
          {fs && (
            <>
              {liveCue && <div className="vf-cue">{liveCue}</div>}
              <div className="vf-bar">
                <button className="vp-btn main" onClick={toggle} disabled={!ready} title={vs.playing ? "Duraklat" : "Oynat"} aria-label={vs.playing ? "Duraklat" : "Oynat"}>
                  {vs.playing ? <Icon d="M7 4v16M17 4v16" w={3} /> : <Icon d="M7 4.5v15l13-7.5-13-7.5Z" fill />}
                </button>
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
                <VolumeControl volume={vs.volume} muted={vs.muted} disabled={!ready} />
                <button className="vf-lang" onClick={toggleCueLang} disabled={!hasTr} title="Altyazı dili">{showTr ? "TR" : origTag}</button>
                <button className="vp-btn" onClick={() => setFs(false)} title="Tam ekrandan çık (Esc)" aria-label="Tam ekrandan çık">
                  <Icon d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                </button>
              </div>
            </>
          )}
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
            <button className="vp-btn" onClick={() => setFs(true)} disabled={!ready} title="Videoyu tam ekran izle (Esc ile çık)" aria-label="Tam ekran">
              <Icon d="M3 8V5a2 2 0 0 1 2-2h3m8 0h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3m-8 0H5a2 2 0 0 1-2-2v-3" />
            </button>
            <button className="vp-btn" onClick={openOnYoutube} title="Videoyu bu andan YouTube'da (tarayıcıda) aç" aria-label="YouTube'da aç">
              <Icon d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </button>
            <span className="vp-sep" />
            <VolumeControl volume={vs.volume} muted={vs.muted} disabled={!ready} />
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
            disabled={!hasTr && !trTitles}
            title={
              hasTr
                ? showTr
                  ? "Türkçe çeviri gösteriliyor; orijinal altyazıya geçmek için tıkla"
                  : "Orijinal altyazı gösteriliyor; Türkçe çeviriye geçmek için tıkla"
                : trTitles
                  ? "Bölüm başlıklarını Türkçe/orijinal göster"
                  : "Türkçe için soldaki metnin zaman işaretli işlenmesi gerekir"
            }
          >
            {cueLang === "tr" && (hasTr || trTitles) ? "TR" : origTag}
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
              <button className="video-title" onClick={openOnYoutube} title="YouTube'da (tarayıcıda) aç">{meta?.title || title}</button>
              {meta?.channel && <div className="video-channel muted">{meta.channel}</div>}
            </div>
          </div>
          {chapters.length > 0 && (
            <div className="vp-chapters">
              <div className="vp-sub">
                Bölümler
                {chTrBusy && !trTitles && <span className="vp-sub-note"> · Türkçeleştiriliyor…</span>}
              </div>
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
                  <span className="vp-ch-n" title={cueLang === "tr" && trTitles ? c.title : trTitles?.[i]}>
                    {cueLang === "tr" && trTitles ? trTitles[i] : c.title}
                  </span>
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

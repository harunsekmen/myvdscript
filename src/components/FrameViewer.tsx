import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { claimKeys } from "../lib/keyScope";

// Akış adresleri birkaç saat geçerlidir; oturum boyunca saklanır, hata olursa yenisi alınır.
const streamCache = new Map<string, Promise<string>>();
function streamUrl(videoId: string, url: string, fresh = false): Promise<string> {
  if (fresh) streamCache.delete(videoId);
  let p = streamCache.get(videoId);
  if (!p) {
    p = api.videoStreamUrl(url);
    p.catch(() => streamCache.delete(videoId));
    streamCache.set(videoId, p);
  }
  return p;
}

interface Props {
  videoId: string;
  url: string;
  /** Kare görüntüleyici açık mı. Kapalıyken de bileşen yerinde durur ve kareyi önceden hazırlar. */
  open: boolean;
  /** Gösterilecek/önceden hazırlanacak an (sn). null: video çalıyor, hazırlık yapılmaz. */
  target: number | null;
  onClose: () => void;
}

const stamp = (s: number) => {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  return `${m}:${(t % 60).toFixed(2).padStart(5, "0")}`;
};

/**
 * Videonun o anki karesini, hiçbir arayüz öğesi olmadan tam ekran gösterir (ekran görüntüsü almak için).
 * YouTube iframe'inden kare alınamadığından yt-dlp'nin verdiği doğrudan görüntü akışı <video> ile açılır.
 * Hız için: akış adresi video açılınca arka planda alınır; video duraklatıldığında gizli <video> o ana
 * sarılır, böylece kamera düğmesine basınca kare anında görünür.
 * ←/→ bir kare (Shift ile 1 sn) kaydırır, Esc kapatır.
 */
export function FrameViewer({ videoId, url, open, target, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState(false); // video süresi/dizini yüklendi mi
  const [shownAt, setShownAt] = useState<number | null>(null); // ekrandaki karenin zamanı
  const retried = useRef(false);
  const stepped = useRef(false); // açıkken ok tuşlarıyla kaydırıldı mı

  const idRef = useRef(videoId);
  idRef.current = videoId;
  const load = (fresh: boolean) => {
    setError(null);
    const id = videoId;
    streamUrl(videoId, url, fresh)
      .then((u) => idRef.current === id && setSrc(u))
      .catch((e) => idRef.current === id && setError(String(e?.message ?? e)));
  };

  // Video değişince sıfırla; akış adresini kısa bir gecikmeyle arka planda al (açılış işleriyle yarışmasın).
  useEffect(() => {
    setSrc(null);
    setMeta(false);
    setShownAt(null);
    setError(null);
    retried.current = false;
    const t = window.setTimeout(() => load(false), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, url]);

  // Açıldığında adres henüz yoksa beklemeden iste.
  useEffect(() => {
    if (open && !src) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Hedef ana sar: açıkken hemen, kapalıyken (duraklatılmışken) kısa bir bekleme sonrası.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !meta || target == null) return;
    const go = () => {
      const t = Math.min(target, v.duration || target);
      if (Math.abs(v.currentTime - t) > 0.02) v.currentTime = t;
      else setShownAt(v.currentTime);
    };
    if (open) return go();
    const h = window.setTimeout(go, 250);
    return () => window.clearTimeout(h);
  }, [target, meta, open]);

  // Açıkken arkadaki panellerin kısayolları (ör. ses kayıtlarının Boşluk/ok tuşları) çalışmaz.
  useEffect(() => (open ? claimKeys(() => "exclusive") : undefined), [open]);

  // Pencereyi gerçekten tam ekran yap; kapanınca eski hâline dön.
  useEffect(() => {
    if (!open) return;
    const win = getCurrentWindow();
    let was = false;
    win
      .isFullscreen()
      .then((f) => {
        was = f;
        if (!f) return win.setFullscreen(true);
      })
      .catch(() => {});
    return () => {
      if (!was) win.setFullscreen(false).catch(() => {});
    };
  }, [open]);

  useEffect(() => {
    stepped.current = false;
  }, [target, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const v = videoRef.current;
      if (!v || !meta || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      stepped.current = true;
      const step = (e.shiftKey ? 1 : 1 / 30) * (e.key === "ArrowLeft" ? -1 : 1);
      v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + step));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, meta]);

  // Ekrandaki kare hedef ana ait mi (ok tuşlarıyla kaydırıldıysa hedeften uzaklaşması normaldir).
  const near = (a: number, b: number) => Math.abs(a - Math.min(b, videoRef.current?.duration || b)) < 0.05;
  const ready = shownAt != null && (stepped.current || target == null || near(shownAt, target));

  return createPortal(
    <div className={"frame-viewer" + (open ? "" : " idle")} aria-hidden={!open} onContextMenu={(e) => e.preventDefault()}>
      {src && (
        <video
          ref={videoRef}
          className={open && !ready ? "stale" : undefined}
          src={src}
          muted
          preload="auto"
          playsInline
          disablePictureInPicture
          onLoadedMetadata={() => setMeta(true)}
          onSeeked={(e) => setShownAt(e.currentTarget.currentTime)}
          onError={() => {
            // Süresi dolmuş adres: bir kez yenisini dene.
            setMeta(false);
            setShownAt(null);
            if (!retried.current) {
              retried.current = true;
              load(true);
            } else setError("Video karesi yüklenemedi");
          }}
        />
      )}
      {open && !ready && !error && <div className="frame-viewer-msg">Kare yükleniyor…</div>}
      {open && error && <div className="frame-viewer-msg error">{error}</div>}
      {open && (
        <div className="frame-viewer-bar">
          {ready && shownAt != null && <span title="←/→ bir kare, Shift ile 1 sn kaydırır">{stamp(shownAt)}</span>}
          <button className="frame-viewer-x" onClick={onClose} title="Kapat (Esc)" aria-label="Kapat">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

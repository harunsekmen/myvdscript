import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ImageMeta } from "../lib/types";

interface Props {
  path: string;
  meta: ImageMeta;
  onNote: (note: string) => void;
  onClose: () => void;
}

export function ImageViewer({ path, meta, onNote, onClose }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.readImage(path).then(setSrc).catch((e) => setErr(String(e)));
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal image-modal">
        <div className="modal-head">
          <span className="modal-title">{meta.name}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="image-stage">
          {err ? <div className="banner error">{err}</div> : src ? <img src={src} alt={meta.name} /> : <div className="muted">Yükleniyor…</div>}
        </div>
        <div className="image-note">
          <label className="muted" htmlFor="img-note">Not (kopyalanan çıktıya eklenir)</label>
          <textarea
            id="img-note"
            className="input"
            rows={2}
            autoFocus
            placeholder="Bu resim için bir not yaz…"
            value={meta.note}
            onChange={(e) => onNote(e.target.value)}
          />
          <div className="muted path" title={path}>{path}</div>
        </div>
      </div>
    </div>
  );
}

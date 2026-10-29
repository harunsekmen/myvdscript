import { useEffect, useState } from "react";
import type { Insight } from "../lib/types";
import { Markdown } from "./Markdown";

interface Props {
  insight: Insight;
  anchor: DOMRect | null;
  models: string[];
  defaultModel: string;
  live: { text: string; error?: string } | null;
  onClose: () => void;
  onDelete: () => void;
  onRerun: (model: string) => void;
}

const W = 440;

export function InsightCard({ insight, anchor, models, defaultModel, live, onClose, onDelete, onRerun }: Props) {
  const n = insight.results.length;
  const [idx, setIdx] = useState(Math.max(0, n - 1));
  const [model, setModel] = useState(insight.results[n - 1]?.model ?? defaultModel);

  // Yeni sonuç gelince en yeniye geç
  useEffect(() => setIdx(Math.max(0, n - 1)), [n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(12, (anchor?.left ?? vw / 2) - 20), vw - W - 12);
  const above = anchor ? anchor.top > 340 : false;
  const style: React.CSSProperties = anchor
    ? above
      ? { left, bottom: vh - anchor.top + 8 }
      : { left, top: Math.min(anchor.bottom + 8, vh - 200) }
    : { left: vw / 2 - W / 2, top: 120 };

  const shown = live && !live.error ? live.text : insight.results[idx]?.text ?? "";
  const modelOptions = Array.from(new Set([model, defaultModel, ...models].filter(Boolean)));

  return (
    <div className="insight-card" style={{ ...style, width: W }}>
      <div className="ic-head">
        <span className="ic-quote" title={insight.quote}>“{insight.quote}”</span>
        <button className="icon-btn" onClick={onClose} title="Kapat (Esc)">✕</button>
      </div>
      <div className="ic-body">
        {live?.error ? (
          <div className="banner error">{live.error}</div>
        ) : shown ? (
          <Markdown text={shown} />
        ) : (
          <div className="muted">Yanıt bekleniyor…</div>
        )}
        {live && !live.error && <span className="caret" />}
      </div>
      <div className="ic-foot">
        {n > 1 && !live && (
          <span className="pager">
            <button className="icon-btn" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>‹</button>
            {idx + 1}/{n}
            <button className="icon-btn" disabled={idx >= n - 1} onClick={() => setIdx(idx + 1)}>›</button>
          </span>
        )}
        <select className="input small" value={model} onChange={(e) => setModel(e.target.value)} title="Model">
          {modelOptions.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <button className="btn small" disabled={!!live && !live.error} onClick={() => onRerun(model)}>
          ↻ Yeniden çalıştır
        </button>
        <button className="btn small danger" onClick={onDelete} title="Bu notu ve vurguyu sil">Sil</button>
      </div>
    </div>
  );
}

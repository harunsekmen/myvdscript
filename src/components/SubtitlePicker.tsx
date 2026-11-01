import { useEffect, useMemo, useState } from "react";
import type { SubOption } from "../lib/api";
import { defaultSubtitle, filterSubtitles } from "../lib/subtitles";

interface Props {
  title: string;
  options: SubOption[];
  onConfirm: (opt: SubOption) => void;
  onCancel: () => void;
}

const keyOf = (o: SubOption) => `${o.auto ? "auto" : "manual"}:${o.lang}`;

/** Videodaki altyazıları listeler; İngilizce varsayılan olarak seçili gelir. */
export function SubtitlePicker({ title, options, onConfirm, onCancel }: Props) {
  const initial = useMemo(() => defaultSubtitle(options), [options]);
  const [selected, setSelected] = useState<string | null>(initial ? keyOf(initial) : null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const visible = useMemo(() => filterSubtitles(options, query), [options, query]);
  const manual = visible.filter((o) => !o.auto);
  const auto = visible.filter((o) => o.auto);
  const chosen = options.find((o) => keyOf(o) === selected);

  const row = (o: SubOption) => {
    const k = keyOf(o);
    return (
      <button
        key={k}
        type="button"
        className={"sub-row" + (k === selected ? " selected" : "")}
        onClick={() => setSelected(k)}
        onDoubleClick={() => onConfirm(o)}
      >
        <span className="sub-radio" aria-hidden />
        <span className="sub-name">{o.name}</span>
        <span className="sub-code mono">{o.lang}</span>
        {o.lang.toLowerCase().startsWith("en") && <span className="sub-badge">EN</span>}
      </button>
    );
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal sub-modal">
        <div className="modal-head">
          <span className="modal-title">Altyazı seçin</span>
        </div>
        <div className="modal-body scroll">
          <p className="muted sub-video" title={title}>{title}</p>
          <input
            className="input"
            autoFocus
            placeholder="Dil ara (ör. en, Türkçe)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {manual.length > 0 && (
            <>
              <label className="muted sub-group">Elle yazılmış ({manual.length})</label>
              <div className="sub-list">{manual.map(row)}</div>
            </>
          )}
          {auto.length > 0 && (
            <>
              <label className="muted sub-group">Otomatik / oto-çeviri ({auto.length})</label>
              <div className="sub-list">{auto.map(row)}</div>
            </>
          )}
          {visible.length === 0 && <p className="muted">Eşleşen altyazı yok.</p>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Vazgeç</button>
          <button className="btn primary" disabled={!chosen} onClick={() => chosen && onConfirm(chosen)}>
            Bu altyazıyla devam et
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { CopyMode } from "../lib/copyExport";

export function CopySplitButton({ onCopy }: { onCopy: (mode: CopyMode) => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const run = async (mode: CopyMode) => {
    setOpen(false);
    await onCopy(mode);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };

  return (
    <div className="split-btn" ref={ref}>
      <button className="btn primary" onClick={() => run("markdown")} title="Markdown olarak kopyala (Ctrl+Shift+C)">
        {done ? "Kopyalandı ✓" : "Tümünü kopyala"}
      </button>
      <button className="btn primary arrow" onClick={() => setOpen(!open)} aria-label="Kopyalama seçenekleri">▾</button>
      {open && (
        <div className="menu right">
          <button onClick={() => run("markdown")}>Tümünü kopyala <span className="muted">Markdown, resim yolu + not</span></button>
          <button onClick={() => run("text")}>Sadece metin <span className="muted">resimsiz düz metin</span></button>
        </div>
      )}
    </div>
  );
}

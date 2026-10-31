import { useEffect, useRef, useState } from "react";
import type { CopyMode } from "../lib/copyExport";

export function CopySplitButton({ onCopy, timed = false }: { onCopy: (mode: CopyMode) => Promise<void> | void; timed?: boolean }) {
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
      <button className="btn primary" onClick={() => run("markdown")} title={timed ? "Zamanlı metni not ve resimleriyle kopyala (Ctrl+Shift+C)" : "Markdown olarak kopyala (Ctrl+Shift+C)"}>
        {done ? "Kopyalandı ✓" : timed ? "Zamanlıyı kopyala" : "Tümünü kopyala"}
      </button>
      <button className="btn primary arrow" onClick={() => setOpen(!open)} aria-label="Kopyalama seçenekleri">▾</button>
      {open && (
        <div className="menu right">
          {timed ? (
            <>
              <button onClick={() => run("markdown")}>Notlar ve resimlerle <span className="muted">kelime zamanları + [NOT] / [RESİM] satırları</span></button>
              <button onClick={() => run("text")}>Sadece zamanlı metin <span className="muted">not ve resim yok</span></button>
            </>
          ) : (
            <>
              <button onClick={() => run("markdown")}>Tümünü kopyala <span className="muted">Markdown, resim yolu + not</span></button>
              <button onClick={() => run("text")}>Sadece metin <span className="muted">resimsiz düz metin</span></button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

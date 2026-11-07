import { useEffect, useRef, useState } from "react";
import type { CopyMode } from "../lib/copyExport";

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** Editörün hemen üstündeki kopyalama düğmesi (yanında kopyalama biçimi menüsü). */
export function CopyButton({ onCopy, timed = false }: { onCopy: (mode: CopyMode) => Promise<void> | void; timed?: boolean }) {
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
    <div className={"copy-btn" + (done ? " done" : "")} ref={ref}>
      <button
        className="copy-main"
        onClick={() => run("markdown")}
        title={timed ? "Zamanlı metni not ve resimleriyle kopyala (Ctrl+Shift+C)" : "Markdown olarak kopyala (Ctrl+Shift+C)"}
      >
        {done ? <CheckIcon /> : <CopyIcon />}
        {done ? "Kopyalandı" : timed ? "Zamanlıyı kopyala" : "Tümünü kopyala"}
      </button>
      <button className="copy-arrow" onClick={() => setOpen(!open)} aria-label="Kopyalama seçenekleri">▾</button>
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

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const win = getCurrentWindow();
  const [max, setMax] = useState(false);

  useEffect(() => {
    const sync = () => win.isMaximized().then(setMax).catch(() => {});
    sync();
    const un = win.onResized(sync);
    return () => {
      un.then((f) => f());
    };
  }, [win]);

  return (
    <div className="win-controls">
      <button onClick={() => win.minimize()} aria-label="Simge durumuna küçült" title="Küçült">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" /></svg>
      </button>
      <button onClick={() => win.toggleMaximize()} aria-label={max ? "Önceki boyut" : "Büyüt"} title={max ? "Önceki boyut" : "Büyüt"}>
        {max ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="1.5" y="3" width="5.5" height="5.5" rx="1" />
            <path d="M3.5 3V2.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7v3.6c0 .4-.3.7-.7.7H7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="1.5" y="1.5" width="7" height="7" rx="1.2" />
          </svg>
        )}
      </button>
      <button className="close" onClick={() => win.close()} aria-label="Kapat" title="Kapat">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

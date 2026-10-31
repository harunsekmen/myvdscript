import { useEffect, useRef, useState } from "react";
import type { CopyMode } from "../lib/copyExport";
import type { ProjectMeta } from "../lib/types";
import { CopySplitButton } from "./CopySplitButton";
import { WindowControls } from "./WindowControls";

interface Props {
  projects: ProjectMeta[];
  currentId: string | null;
  openSignal: number;
  onSelect: (id: string) => void;
  onNewBlank: () => void;
  onNewFromLink: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClearAll: () => void;
  onCopy: (mode: CopyMode) => Promise<void> | void;
  copyTimed?: boolean;
  onSettings: () => void;
}

export function TopBar(p: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const current = p.projects.find((x) => x.id === p.currentId);

  useEffect(() => {
    if (p.openSignal) setOpen(true);
  }, [p.openSignal]);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const list = p.projects.filter((x) => x.title.toLowerCase().includes(q.toLowerCase()));
  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region><img src="/icon.svg" alt="" width="20" height="20" />Script Atölyesi</div>
      <div className="dropdown" ref={ref}>
        <button className="btn proj-btn" onClick={() => setOpen(!open)} title="Projeler (Ctrl+K)">
          <span className="proj-name">{current?.title ?? "Proje seç…"}</span>
          <span className="muted">▾</span>
        </button>
        {open && (
          <div className="menu proj-menu">
            <input className="input" autoFocus placeholder="Proje ara…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="menu-list">
              {list.length === 0 && <div className="muted pad">Proje yok</div>}
              {list.map((x) => (
                <button key={x.id} className={x.id === p.currentId ? "on" : ""} onClick={act(() => p.onSelect(x.id))}>
                  <span className="ellipsis">{x.title}</span>
                  <span className="muted">{new Date(x.updatedAt).toLocaleDateString("tr-TR")}</span>
                </button>
              ))}
            </div>
            <div className="menu-sep" />
            <button onClick={act(p.onNewBlank)}>＋ Boş şablon</button>
            <button onClick={act(p.onNewFromLink)}>＋ Linkten başlat</button>
            {current && <button onClick={act(p.onRename)}>Yeniden adlandır</button>}
            {current && <button className="danger" onClick={act(p.onDelete)}>Projeyi sil</button>}
            <div className="menu-sep" />
            <button className="danger" onClick={act(p.onClearAll)}>Tümünü temizle…</button>
          </div>
        )}
      </div>
      <button className="btn" onClick={p.onNewFromLink}>＋ Linkten başlat</button>
      <div className="spacer" data-tauri-drag-region />
      <CopySplitButton onCopy={p.onCopy} timed={p.copyTimed} />
      <button className="btn" onClick={p.onSettings} title="Ayarlar (Ctrl+,)">⚙ Ayarlar</button>
      <WindowControls />
    </header>
  );
}

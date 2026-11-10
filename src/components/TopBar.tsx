import { useEffect, useRef, useState } from "react";
import type { ProjectPatch } from "../lib/api";
import type { ProjectMeta, StageDef } from "../lib/types";
import { StagePanel, StagePill } from "./StagePanel";
import { WindowControls } from "./WindowControls";

interface Props {
  projects: ProjectMeta[];
  currentId: string | null;
  view: "home" | "project";
  stages: StageDef[];
  onHome: () => void;
  onEdit: (id: string, patch: ProjectPatch) => void;
  openSignal: number;
  onSelect: (id: string) => void;
  onNewBlank: () => void;
  onNewFromLink: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClearAll: () => void;
  onSettings: () => void;
}

export function TopBar(p: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [panel, setPanel] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const current = p.projects.find((x) => x.id === p.currentId);

  useEffect(() => {
    if (p.openSignal) setOpen(true);
  }, [p.openSignal]);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const closePanel = (e: MouseEvent) => !panelRef.current?.contains(e.target as Node) && setPanel(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("mousedown", closePanel);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("mousedown", closePanel);
    };
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
      <button className={"btn home-btn" + (p.view === "home" ? " on" : "")} onClick={p.onHome} title="Ana sayfa (Ctrl+H)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />
        </svg>
        Ana sayfa
      </button>
      {p.view === "project" && (
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
      )}
      {p.view === "project" && current && (
        <div className="dropdown" ref={panelRef}>
          <button className="stage-trigger" onClick={() => setPanel(!panel)} title="Aşama ve kontrol listesi">
            <StagePill stages={p.stages} id={current.stage} />
            {current.checkTotal > 0 && <span className="muted tnum">{current.checkDone}/{current.checkTotal}</span>}
          </button>
          {panel && (
            <div className="menu stage-menu">
              <StagePanel
                stages={p.stages}
                stage={current.stage}
                checklist={current.checklist ?? []}
                note={current.note}
                onChange={(patch) => p.onEdit(current.id, patch)}
              />
            </div>
          )}
        </div>
      )}
      {p.view === "project" && <button className="btn" onClick={p.onNewFromLink}>＋ Linkten başlat</button>}
      <div className="spacer" data-tauri-drag-region />
      <button className="icon-btn settings-btn" onClick={p.onSettings} title="Ayarlar (Ctrl+,)" aria-label="Ayarlar">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <WindowControls />
    </header>
  );
}

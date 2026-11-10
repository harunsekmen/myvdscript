import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { useVideoStats } from "../hooks/useVideoStats";
import { api, type ProjectPatch } from "../lib/api";
import {
  filterSort,
  formatCount,
  formatDelta,
  formatDuration,
  projectStats,
  resolveStage,
  timeAgo,
  type ProjectStats,
} from "../lib/home";
import type { HomeSort, ProjectMeta, Settings } from "../lib/types";
import { StagePanel } from "./StagePanel";

interface Props {
  projects: ProjectMeta[];
  settings: Settings;
  /** Arka planda işlenen projenin kimliği (kartta "İşleniyor…" gösterilir). */
  runningId: string | null;
  /** Sırada bekleyen projeler (sıra düzeninde). */
  queuedIds: string[];
  videoStats: ReturnType<typeof useVideoStats>;
  onOpen: (id: string) => void;
  onNewFromLink: () => void;
  onNewBlank: () => void;
  onEdit: (id: string, patch: ProjectPatch) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onSettings: (patch: Partial<Settings>) => void;
  /** Ctrl+K: ana sayfada arama kutusuna odaklanır. */
  focusSignal: number;
}

const SORTS: { v: HomeSort; label: string }[] = [
  { v: "updated", label: "Son düzenlenen" },
  { v: "views", label: "En çok izlenen" },
  { v: "created", label: "Eklenme" },
];

/** Arşiv sütununun sürükle-bırak kimliği. */
const ARCHIVE = "__archive";

/** Her 30 sn yeniden çizdirir ("2 dk önce" metinleri güncellensin). */
function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Eski sürümlerde bozuk kaydedilmiş (� içeren) başlık yerine videonun güncel başlığı gösterilir. */
export function displayTitle(meta: ProjectMeta, ps: ProjectStats): string {
  if (!meta.title.includes("�")) return meta.title;
  return ps.videos.find((v) => v.stat?.title)?.stat?.title ?? meta.title;
}

function Thumb({ id, title }: { id: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  if (!id || failed) {
    return (
      <div className="kthumb-img ph" aria-hidden="true">
        <span>{(title.trim()[0] ?? "▶").toLocaleUpperCase("tr")}</span>
      </div>
    );
  }
  return <img className="kthumb-img" src={`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />;
}

const Icon = ({ d, size = 13, fill = "none" }: { d: string; size?: number; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const I = {
  pin: "M12 17v5M8 3h8l-1 6 3 4H6l3-4z",
  check: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  note: "M4 4h16v12H8l-4 4z",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  up: "M7 17L17 7M9 7h8v8",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4",
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-4.3-4.3",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
};

/**
 * Açılır pencere: önce tıklanan noktaya yerleşir, sonra gerçek boyutu ölçülüp pencere içine sığdırılır
 * (sağ/alt kenara yakınsa sola/yukarı kayar).
 */
function PopBox({ x, y, width, className, children }: { x: number; y: number; width: number; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const M = 8;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - M) left = Math.max(M, window.innerWidth - r.width - M);
    if (top + r.height > window.innerHeight - M) top = Math.max(M, window.innerHeight - r.height - M);
    setPos({ left, top, ready: true });
  }, [x, y, className]);
  return (
    <div
      ref={ref}
      className={className}
      style={{ left: pos.left, top: pos.top, width, visibility: pos.ready ? "visible" : "hidden" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

const STAGE_COLORS = ["#6c8cff", "#a78bfa", "#f5b84b", "#4fd1a5", "#f0883e", "#ef7a8c", "#5ec8e5", "#c792ea"];

/** Kullanıcının panoya eklediği yeni aşama (kalıcı; Ayarlar > Ana sayfa'dan düzenlenir/silinir). */
const newStage = (label: string, i: number) => ({ id: crypto.randomUUID().slice(0, 8), label, color: STAGE_COLORS[i % STAGE_COLORS.length] });

/** Panonun sonunda "＋ Aşama ekle" sütunu: tıklayınca ad girilir. */
function AddStageColumn({ onAdd }: { onAdd: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const done = (save: boolean) => {
    const label = val.trim();
    if (save && label) onAdd(label);
    setVal("");
    setEditing(false);
  };
  if (!editing) {
    return (
      <button className="kcol-add" onClick={() => setEditing(true)} title="Panoya yeni bir aşama sütunu ekle (Ayarlar > Ana sayfa'dan düzenlenebilir)">
        ＋ Aşama ekle
      </button>
    );
  }
  return (
    <div className="kcol-add editing">
      <input
        className="input"
        autoFocus
        placeholder="Aşama adı"
        value={val}
        maxLength={40}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done(true);
          if (e.key === "Escape") done(false);
        }}
        onBlur={() => done(true)}
      />
    </div>
  );
}

interface CardProps {
  meta: ProjectMeta;
  ps: ProjectStats;
  loading: boolean;
  running: boolean;
  /** Sıradaki konumu (1'den başlar); sırada değilse 0. */
  queuePos: number;
  last: boolean;
  dragging: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  onPanel: (x: number, y: number) => void;
  onPin: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function KanbanCard({ meta, ps, loading, running, queuePos, last, dragging, onOpen, onMenu, onPanel, onPin, onDragStart, onDragEnd }: CardProps) {
  const first = ps.videos.find((v) => v.id) ?? null;
  const multi = ps.videos.length > 1;
  const st = first?.stat;
  const title = displayTitle(meta, ps);
  const pct = meta.checkTotal ? Math.round((meta.checkDone / meta.checkTotal) * 100) : 0;
  const allDone = meta.checkTotal > 0 && meta.checkDone === meta.checkTotal;
  const at = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    return [r.left, r.bottom + 6] as const;
  };

  const channel = multi ? `${ps.videos.length} video` : st?.channel;
  const views = ps.totalViews != null ? `${formatCount(ps.totalViews)} görüntüleme${multi ? " (toplam)" : ""}` : null;
  const uploaded = !multi && st?.uploadedAt ? timeAgo(st.uploadedAt) : null;

  return (
    <div
      className={"kcard" + (running ? " running" : queuePos ? " queued" : "") + (dragging ? " dragging" : "") + (meta.pinned ? " pinned" : "") + (meta.archived ? " archived" : "")}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", meta.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div className={"kthumb" + (multi ? " stacked" : "")}>
        <div className="kthumb-inner">
          <Thumb id={first?.id ?? null} title={title} />
          {(st?.duration ?? 0) > 0 && !multi && <span className="kbadge dur">{formatDuration(st!.duration)}</span>}
          {multi && <span className="kbadge count">▤ {ps.videos.length} video</span>}
          {running && <span className="kbadge run">İşleniyor…</span>}
          {!running && queuePos > 0 && <span className="kbadge queued">Sırada · {queuePos}</span>}
          {!running && !queuePos && last && <span className="kbadge last">Son açılan</span>}
          {multi && (
            <div className="khover">
              {ps.videos.map((v, i) => (
                <div key={v.url + i}>
                  <span className="ellipsis">{v.stat?.title || v.title || v.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
                  <b className="tnum">{v.stat?.views != null ? formatCount(v.stat.views) : "—"}</b>
                </div>
              ))}
            </div>
          )}
          <div className="ktools">
            <button
              className={"ktool" + (meta.pinned ? " on" : "")}
              title={meta.pinned ? "Sabitlemeyi kaldır" : "Sabitle"}
              aria-label="Sabitle"
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
            >
              <Icon d={I.pin} fill={meta.pinned ? "currentColor" : "none"} />
            </button>
            <button className="ktool" title="Menü" aria-label="Menü" onClick={(e) => onMenu(...at(e))}>
              <Icon d={I.more} size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className="kbody">
        <div className="ktitle" title={title}>{title}</div>
        {!ps.videos.length ? (
          <div className="kmeta muted">Video bağlantısı yok</div>
        ) : loading && !st ? (
          <div className="kmeta">
            <span className="shimmer" style={{ width: "55%" }} />
            <span className="shimmer" style={{ width: "75%" }} />
          </div>
        ) : (
          <div className="kmeta">
            {channel && <span className="kchannel ellipsis">{channel}</span>}
            <span className="kstats">
              {views ?? "İstatistik yok"}
              {uploaded && <> · {uploaded}</>}
            </span>
          </div>
        )}

        {meta.note.trim() && (
          <button className="knote" title={meta.note} onClick={(e) => onPanel(...at(e))}>
            <Icon d={I.note} size={12} />
            <span className="ellipsis">{meta.note}</span>
          </button>
        )}

        <div className="kfoot">
          <button className={"kcheck" + (allDone ? " done" : "") + (meta.checkTotal ? "" : " empty")} title="Kontrol listesi ve not" onClick={(e) => onPanel(...at(e))}>
            <Icon d={I.check} size={12} />
            {meta.checkTotal ? (
              <>
                <span className="kbar" style={{ "--p": `${pct}%` } as CSSProperties} />
                <span className="tnum">{meta.checkDone}/{meta.checkTotal}</span>
              </>
            ) : (
              <span>Liste ekle</span>
            )}
          </button>
          <span className="spacer" />
          {ps.delta != null && (
            <span className="kdelta" title="Son ölçümden beri yeni görüntüleme">
              <Icon d={I.up} size={11} />
              {formatDelta(ps.delta).slice(1)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function HomePage({ projects, settings, runningId, queuedIds, videoStats, onOpen, onNewFromLink, onNewBlank, onEdit, onRename, onDelete, onSettings, focusSignal }: Props) {
  useTick(30000);
  const { stats, progress, lastUpdated, failed, error, refresh, cacheLoaded } = videoStats;
  const [query, setQuery] = useState("");
  const [pop, setPop] = useState<{ id: string; x: number; y: number; kind: "menu" | "panel" } | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stages = settings.stages;
  const sort: HomeSort = settings.homeSort === "stage" ? "updated" : settings.homeSort;

  useEffect(() => {
    if (focusSignal) searchRef.current?.focus();
  }, [focusSignal]);
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPop(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pop]);

  const f = { query, stage: null, sort };
  const active = useMemo(() => filterSort(projects.filter((p) => !p.archived), f, stats, stages), [projects, query, sort, stats, stages]); // eslint-disable-line react-hooks/exhaustive-deps
  const archived = useMemo(() => filterSort(projects.filter((p) => p.archived), f, stats, stages), [projects, query, sort, stats, stages]); // eslint-disable-line react-hooks/exhaustive-deps
  const archivedTotal = projects.filter((p) => p.archived).length;
  const pending = progress != null;

  const columns = useMemo(() => {
    const map = new Map<string, ProjectMeta[]>(stages.map((s) => [s.id, []]));
    for (const m of active) map.get(resolveStage(stages, m.stage).id)?.push(m);
    return map;
  }, [active, stages]);

  const drop = (col: string) => {
    const id = dragId;
    setDropCol(null);
    setDragId(null);
    const m = projects.find((p) => p.id === id);
    if (!m || !id) return;
    if (col === ARCHIVE) {
      if (!m.archived) onEdit(id, { archived: true });
    } else if (m.archived || resolveStage(stages, m.stage).id !== col) {
      onEdit(id, m.archived ? { archived: false, stage: col } : { stage: col });
    }
  };

  const colProps = (col: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropCol !== col) setDropCol(col);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropCol((d) => (d === col ? null : d));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      drop(col);
    },
  });

  const card = (m: ProjectMeta) => (
    <KanbanCard
      key={m.id}
      meta={m}
      ps={projectStats(m, stats)}
      loading={pending || !cacheLoaded}
      running={runningId === m.id}
      queuePos={queuedIds.indexOf(m.id) + 1}
      last={m.id === settings.lastProjectId}
      dragging={dragId === m.id}
      onOpen={() => onOpen(m.id)}
      onMenu={(x, y) => setPop({ id: m.id, x, y, kind: "menu" })}
      onPanel={(x, y) => setPop({ id: m.id, x, y, kind: "panel" })}
      onPin={() => onEdit(m.id, { pinned: !m.pinned })}
      onDragStart={() => setDragId(m.id)}
      onDragEnd={() => {
        setDragId(null);
        setDropCol(null);
      }}
    />
  );

  const popMeta = pop ? projects.find((p) => p.id === pop.id) : null;
  const closePop = () => setPop(null);
  const item = (label: string, fn: () => void, cls = "") => (
    <button
      className={cls}
      onClick={() => {
        closePop();
        fn();
      }}
    >
      {label}
    </button>
  );

  const renderPop = () => {
    if (!pop || !popMeta) return null;
    const w = pop.kind === "menu" ? 250 : 340;
    const firstUrl = projectStats(popMeta, stats).videos.find((v) => v.id)?.url;
    const cur = resolveStage(stages, popMeta.stage).id;
    return (
      <div className="home-pop-back" onMouseDown={closePop} onContextMenu={(e) => (e.preventDefault(), closePop())}>
        <PopBox key={pop.kind} x={pop.x} y={pop.y} width={w} className={"home-pop " + pop.kind}>
          {pop.kind === "menu" ? (
            <div className="menu-flat">
              {item("Aç", () => onOpen(popMeta.id))}
              {firstUrl && item("YouTube'da aç", () => api.openExternal(firstUrl).catch(() => {}))}
              <div className="menu-sep" />
              <div className="menu-label muted">Taşı</div>
              <div className="menu-stages">
                {stages.map((s) => (
                  <button
                    key={s.id}
                    className={s.id === cur && !popMeta.archived ? "on" : ""}
                    style={{ "--c": s.color } as CSSProperties}
                    title={s.label}
                    onClick={() => {
                      closePop();
                      onEdit(popMeta.id, popMeta.archived ? { stage: s.id, archived: false } : { stage: s.id });
                    }}
                  >
                    <i />
                    <span className="ellipsis">{s.label}</span>
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              <button onClick={() => setPop({ ...pop, kind: "panel" })}>Kontrol listesi ve not…</button>
              {item(popMeta.pinned ? "Sabitlemeyi kaldır" : "Sabitle", () => onEdit(popMeta.id, { pinned: !popMeta.pinned }))}
              {item(popMeta.archived ? "Arşivden çıkar" : "Arşivle", () => onEdit(popMeta.id, { archived: !popMeta.archived }))}
              {item("Yeniden adlandır", () => onRename(popMeta.id))}
              <div className="menu-sep" />
              {item("Sil", () => onDelete(popMeta.id), "danger")}
            </div>
          ) : (
            <StagePanel stages={stages} stage={popMeta.stage} checklist={popMeta.checklist ?? []} note={popMeta.note} onChange={(patch) => onEdit(popMeta.id, patch)} />
          )}
        </PopBox>
      </div>
    );
  };

  if (projects.length === 0) {
    return (
      <main className="home">
        <div className="home-empty">
          <h1>Script Atölyesi</h1>
          <p className="muted">Bir video linkinden başla ya da boş bir şablonla yaz.</p>
          <div className="row center">
            <button className="btn primary" onClick={onNewFromLink}>＋ Linkten başlat</button>
            <button className="btn" onClick={onNewBlank}>＋ Boş şablon</button>
          </div>
        </div>
      </main>
    );
  }

  const status = error ? (
    <span className="err" title={error}>Güncellenemedi</span>
  ) : pending ? (
    <span className="tnum">Güncelleniyor {progress!.done}/{progress!.total}</span>
  ) : lastUpdated ? (
    <span>
      {timeAgo(lastUpdated)} güncellendi
      {failed > 0 && <span className="err" title="Bu videoların bilgisi alınamadı (özel/silinmiş ya da bağlantı sorunu)"> · {failed} alınamadı</span>}
    </span>
  ) : null;

  return (
    <main className="home">
      <div className="home-bar">
        <div className="home-search">
          <Icon d={I.search} size={14} />
          <input ref={searchRef} placeholder="Ara… (Ctrl+K)" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        </div>
        <div className="s-seg home-sort" role="radiogroup" aria-label="Sırala">
          {SORTS.map((s) => (
            <button key={s.v} role="radio" aria-checked={sort === s.v} className={sort === s.v ? "on" : ""} onClick={() => onSettings({ homeSort: s.v })}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="home-status muted">{status}</span>
        <button className={"icon-btn home-refresh" + (pending ? " spin" : "")} disabled={pending} onClick={() => void refresh()} title="İzlenme sayılarını yenile" aria-label="Yenile">
          <Icon d={I.refresh} size={16} />
        </button>
        {archivedTotal > 0 && (
          <button className={"btn home-arch" + (showArchive ? " on" : "")} onClick={() => setShowArchive(!showArchive)} title="Arşiv sütununu göster/gizle">
            <Icon d={I.archive} size={14} /> Arşiv <span className="tnum muted">{archivedTotal}</span>
          </button>
        )}
        <button className="btn primary" onClick={onNewFromLink}>＋ Linkten başlat</button>
      </div>

      <div className={"board" + (dragId ? " is-dragging" : "")}>
        {stages.map((s) => {
          const col = columns.get(s.id) ?? [];
          return (
            <section key={s.id} className={"kcol" + (dropCol === s.id ? " drop" : "")} style={{ "--c": s.color } as CSSProperties} {...colProps(s.id)}>
              <header className="kcol-head">
                <i />
                <span className="ellipsis">{s.label}</span>
                <b className="tnum">{col.length}</b>
              </header>
              <div className="kcol-body">
                {col.map(card)}
                {col.length === 0 && <div className="kcol-empty">{dragId ? "Buraya bırak" : query ? "Eşleşen yok" : "Boş"}</div>}
              </div>
            </section>
          );
        })}
        {!dragId && <AddStageColumn onAdd={(label) => onSettings({ stages: [...stages, newStage(label, stages.length)] })} />}
        {(showArchive || dragId) && archivedTotal + (dragId ? 1 : 0) > 0 && (
          <section className={"kcol archive" + (dropCol === ARCHIVE ? " drop" : "")} style={{ "--c": "#6b7085" } as CSSProperties} {...colProps(ARCHIVE)}>
            <header className="kcol-head">
              <Icon d={I.archive} size={13} />
              <span>Arşiv</span>
              <b className="tnum">{archived.length}</b>
            </header>
            <div className="kcol-body">
              {showArchive && archived.map(card)}
              {(!showArchive || archived.length === 0) && <div className="kcol-empty">{dragId ? "Arşivlemek için bırak" : "Boş"}</div>}
            </div>
          </section>
        )}
      </div>
      {renderPop()}
    </main>
  );
}

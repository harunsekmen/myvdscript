import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ConfirmDialog, TextDialog } from "./components/Dialogs";
import { LeftPane } from "./components/LeftPane";
import { RightPane, type RightTab } from "./components/RightPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { SubtitlePicker } from "./components/SubtitlePicker";
import { TopBar } from "./components/TopBar";
import { VideoPanel } from "./components/VideoPanel";
import { usePipeline } from "./hooks/usePipeline";
import { useProjectStore, type PipelineLifecycle } from "./hooks/useProjectStore";
import { useSplitLayout } from "./hooks/useSplitLayout";
import { api } from "./lib/api";
import { createAutosaver } from "./lib/autosave";
import { exportDoc, type CopyMode } from "./lib/copyExport";
import { fontCss } from "./lib/fonts";
import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT, isLegacySystemPrompt } from "./lib/prompts";
import { activeSource, patchSource, removeSource, sourceLabel } from "./lib/sources";
import { exportTimed } from "./lib/timed";
import type { ImageMeta, Insight, Settings, TimedDoc } from "./lib/types";
import { videoIdOf } from "./lib/youtube";
import { DEFAULT_SETTINGS } from "./lib/settingsDefaults";

const DEFAULTS = DEFAULT_SETTINGS;

type Dialog =
  | { kind: "link" }
  | { kind: "rename" }
  | { kind: "delete" }
  | { kind: "clear" }
  | { kind: "removeSource"; id: string }
  | null;

interface Toast { id: number; msg: string; kind: "error" | "info" }

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const settingsRef = useRef(settings);
  const [hasKey, setHasKey] = useState(false);
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const [tab, setTab] = useState<RightTab>("write");
  const [models, setModels] = useState<string[]>([]);
  const getDocRef = useRef<() => any>(() => null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openSignal, setOpenSignal] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);
  const [wordCount, setWordCount] = useState("");

  const settingsSaver = useMemo(() => createAutosaver<Settings>((s) => api.saveSettings(s), () => {}, 500), []);

  const toast = useCallback((msg: string, kind: "error" | "info" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3000);
  }, []);

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      settingsSaver.schedule(next);
    },
    [settingsSaver],
  );

  // Proje durumu ile işleme hattı birbirine bağlıdır (proje değişince işlem iptal edilir); kanca ref ile kurulur.
  const lifecycle = useRef<PipelineLifecycle>({ cancel: () => {}, reset: () => {} });
  const { projects, project, projectRef, status, saver, mutate, openProject, loadInitial, createProject, rename, deleteCurrent, clearAll } =
    useProjectStore({ patchSettings, lifecycle });
  const pipe = usePipeline({ projectRef, mutate, settingsRef, toast, openSettings: () => setShowSettings(true) });
  lifecycle.current = {
    cancel: pipe.cancelRun,
    reset: () => {
      pipe.reset();
      setTab("write");
    },
  };

  const refreshModels = useCallback(async () => {
    try {
      setModels(await api.listModels(settingsRef.current.baseUrl));
    } catch {
      /* sessiz: anahtar/adres henüz girilmemiş olabilir */
    }
  }, []);

  // ---- Açılış ----
  useEffect(() => {
    (async () => {
      const loaded = await api.loadSettings();
      const s: Settings = { ...DEFAULTS, ...loaded };
      if (!s.systemPrompt.trim() || isLegacySystemPrompt(s.systemPrompt)) s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
      if (!s.insightPrompt.trim()) s.insightPrompt = DEFAULT_INSIGHT_PROMPT;
      settingsRef.current = s;
      setSettings(s);
      setHasKey(await api.hasApiKey());
      setHasGroqKey(await api.hasGroqKey());
      await loadInitial(s.lastProjectId);
      setReady(true);
      refreshModels(); // yerel sunucular anahtarsız da çalışabilir
    })().catch((e) => {
      toast(`Başlatma hatası: ${e}`, "error");
      setReady(true);
    });
  }, [refreshModels, toast, loadInitial]);

  // ---- Ayarları CSS değişkenlerine uygula ----
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--ui-font", fontCss(settings.uiFont));
    r.setProperty("--read-font", fontCss(settings.readFont));
    r.setProperty("--write-font", fontCss(settings.writeFont));
    r.setProperty("--font-size", `${settings.fontSize}px`);
    r.setProperty("--line-height", String(settings.lineHeight));
    r.setProperty("--text-width", `${settings.textWidth}px`);
  }, [settings]);

  // ---- Pencere kapanırken kaydet ----
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (e) => {
      e.preventDefault();
      try {
        await Promise.all([saver.flush(), settingsSaver.flush()]);
      } finally {
        await win.destroy();
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [saver, settingsSaver]);

  // ---- Proje işlemleri ----
  const newBlank = async () => {
    try {
      await createProject("Yeni proje", "");
    } catch (e) {
      toast(`Proje oluşturulamadı: ${e}`, "error");
    }
  };

  const newFromLink = async (url: string) => {
    setDialog(null);
    try {
      const p = await createProject("Yükleniyor…", url);
      await pipe.fetchForSource(p.sources[0].id, url);
    } catch (e) {
      toast(`${e}`, "error");
    }
  };

  const renameCurrent = (title: string) => {
    setDialog(null);
    rename(title);
  };

  const deleteProject = async () => {
    setDialog(null);
    try {
      await deleteCurrent();
    } catch (e) {
      toast(`Silinemedi: ${e}`, "error");
    }
  };

  const clearEverything = async () => {
    setDialog(null);
    try {
      await clearAll();
      toast("Tüm projeler temizlendi");
    } catch (e) {
      toast(`Temizlenemedi: ${e}`, "error");
    }
  };

  const confirmRemoveSource = () => {
    const id = dialog?.kind === "removeSource" ? dialog.id : null;
    setDialog(null);
    if (!id) return;
    pipe.abortSource(id);
    mutate((p) => removeSource(p, id));
  };

  // ---- Kopyala (aktif sekmeye göre) ----
  const copy = useCallback(
    async (mode: CopyMode) => {
      const p = projectRef.current;
      if (!p) return toast("Kopyalanacak proje yok", "error");
      const timedActive = tab === "timed" && !!p.timed;
      const text = timedActive
        ? exportTimed(p.timed ?? null, p.imageMeta, mode)
        : exportDoc(getDocRef.current() ?? p.editorDoc, p.imageMeta, mode);
      if (!text.trim()) return toast(timedActive ? "Zamanlı metin boş" : "Senaryo boş", "error");
      try {
        await writeText(text);
      } catch (e) {
        toast(`Kopyalanamadı: ${e}`, "error");
      }
    },
    [toast, tab, projectRef],
  );

  // ---- Kısayollar ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpenSignal((n) => n + 1);
      } else if (e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copy("markdown");
      } else if (e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy]);

  // ---- Etkin kaynak ve bölme çubuğu ----
  const source = project ? activeSource(project) : null;
  const videoMarks = useMemo(
    () => [...new Set((source?.segments ?? []).flatMap((s) => (s.marks ?? []).map((m) => m.t)))].sort((a, b) => a - b),
    [source?.segments],
  );
  const hasVideoPane = !!source && !!videoIdOf(source.url);
  const { splitRef, L, M, startDrag } = useSplitLayout(settings, patchSettings, hasVideoPane);

  const onInsights = useCallback(
    (sourceId: string, insights: Insight[]) => mutate((p) => patchSource(p, sourceId, (s) => ({ ...s, insights }))),
    [mutate],
  );
  const onSelectSource = useCallback((id: string) => mutate((p) => (p.activeSourceId === id ? p : { ...p, activeSourceId: id })), [mutate]);
  const onDoc = useCallback((doc: any) => mutate((p) => ({ ...p, editorDoc: doc }), false), [mutate]);
  const onTimed = useCallback((doc: TimedDoc) => mutate((p) => ({ ...p, timed: doc })), [mutate]);
  // Arka planda gelen sonuçlar (AI önerileri) en güncel zamanlı metne uygulanır.
  const patchTimed = useCallback(
    (fn: (d: TimedDoc) => TimedDoc) => mutate((p) => (p.timed ? { ...p, timed: fn(p.timed) } : p)),
    [mutate],
  );
  const onMeta = useCallback(
    (path: string, meta: ImageMeta | null) =>
      mutate((p) => {
        const m = { ...p.imageMeta };
        if (meta) m[path] = meta;
        else delete m[path];
        return { ...p, imageMeta: m };
      }),
    [mutate],
  );
  const registerGetDoc = useCallback((fn: () => any) => {
    getDocRef.current = fn;
  }, []);

  const statusText = {
    idle: "",
    pending: "Değişiklikler bekliyor…",
    saving: "Kaydediliyor…",
    saved: "Kaydedildi ✓",
    error: `Kayıt hatası: ${status.err ?? ""}`,
  }[status.s];

  if (!ready) return <div className="boot">Yükleniyor…</div>;

  const removing =
    dialog?.kind === "removeSource" && project ? project.sources.findIndex((s) => s.id === dialog.id) : -1;

  return (
    <div className="app">
      <TopBar
        projects={projects}
        currentId={project?.id ?? null}
        openSignal={openSignal}
        onSelect={(id) => openProject(id).catch((e) => toast(`${e}`, "error"))}
        onNewBlank={newBlank}
        onNewFromLink={() => setDialog({ kind: "link" })}
        onRename={() => setDialog({ kind: "rename" })}
        onDelete={() => setDialog({ kind: "delete" })}
        onClearAll={() => setDialog({ kind: "clear" })}
        onSettings={() => setShowSettings(true)}
      />

      {project && source ? (
        <main className="split" ref={splitRef}>
          <div className="split-left" style={{ width: `${(hasVideoPane ? L : settings.splitRatio) * 100}%` }}>
            <LeftPane
              project={project}
              settings={settings}
              models={models}
              proc={pipe.proc}
              onInsights={onInsights}
              onReprocess={pipe.reprocess}
              onCustomRun={pipe.customRun}
              onCancel={pipe.cancel}
              onResume={pipe.resume}
              onFetchUrl={pipe.fetchActive}
              onSelectSource={onSelectSource}
              onAddSource={pipe.addSourceFromUrl}
              onRemoveSource={(id) => setDialog({ kind: "removeSource", id })}
              onPickSubtitle={pipe.pickSubtitle}
              onRestore={pipe.restoreVersion}
              onToast={toast}
            />
          </div>
          <div className="divider" onPointerDown={startDrag("left")} />
          {hasVideoPane && (
            <>
              <div className="split-mid" style={{ width: `${M * 100}%` }}>
                <VideoPanel
                  key={source.id}
                  url={source.url}
                  title={source.title.trim() || project.title}
                  marks={videoMarks}
                  transcriptRaw={source.transcriptRaw}
                  onToast={toast}
                />
              </div>
              <div className="divider" onPointerDown={startDrag("right")} />
            </>
          )}
          <div className="split-right">
            <RightPane
              key={project.id}
              project={project}
              tab={tab}
              onTab={setTab}
              settings={settings}
              hasGroqKey={hasGroqKey}
              onOpenSettings={() => setShowSettings(true)}
              onDoc={onDoc}
              onTimed={onTimed}
              onPatchTimed={patchTimed}
              onMeta={onMeta}
              onToast={toast}
              registerGetDoc={registerGetDoc}
              onCopy={copy}
              onCount={setWordCount}
            />
          </div>
        </main>
      ) : (
        <main className="welcome">
          <h1>Script Atölyesi</h1>
          <p className="muted">Bir video linkinden başla ya da boş bir şablonla yaz.</p>
          <div className="row center">
            <button className="btn primary" onClick={() => setDialog({ kind: "link" })}>＋ Linkten başlat</button>
            <button className="btn" onClick={newBlank}>＋ Boş şablon</button>
          </div>
        </main>
      )}

      <footer className="statusbar">
        <span className="muted">
          {settings.model ? `Model: ${settings.model}` : "Model seçilmedi"} · Ctrl+K proje · Ctrl+Shift+C kopyala
        </span>
        <span className="spacer" />
        {project && (
          <span className={"status-save " + (status.s === "error" ? "err" : status.s === "saved" || status.s === "idle" ? "ok" : "muted")}>
            {statusText || "Kaydedildi ✓"}
          </span>
        )}
        {project && wordCount && <span className="status-count muted tnum">{wordCount}</span>}
      </footer>

      {showSettings && (
        <SettingsDialog
          settings={settings}
          models={models}
          hasKey={hasKey}
          hasGroqKey={hasGroqKey}
          onChange={patchSettings}
          onModels={setModels}
          onKeyChanged={setHasKey}
          onGroqKeyChanged={setHasGroqKey}
          onClose={() => setShowSettings(false)}
        />
      )}
      {pipe.subPick && (
        <SubtitlePicker
          title={pipe.subPick.list.title}
          options={pipe.subPick.list.options}
          onConfirm={pipe.downloadSubtitle}
          onCancel={() => pipe.setSubPick(null)}
        />
      )}
      {dialog?.kind === "link" && (
        <TextDialog title="Linkten başlat" label="YouTube video bağlantısı" placeholder="https://www.youtube.com/watch?v=…" confirmLabel="Başlat" onSubmit={newFromLink} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "rename" && project && (
        <TextDialog title="Projeyi yeniden adlandır" initial={project.title} confirmLabel="Kaydet" onSubmit={renameCurrent} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && project && (
        <ConfirmDialog title="Projeyi sil" message={`“${project.title}” ve resimleri kalıcı olarak silinecek.`} confirmLabel="Sil" danger onConfirm={deleteProject} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "clear" && (
        <ConfirmDialog title="Tümünü temizle" message="Tüm projeler, scriptler ve kaydedilmiş resimler kalıcı olarak silinecek. Bu işlem geri alınamaz." confirmLabel="Hepsini sil" danger onConfirm={clearEverything} onCancel={() => setDialog(null)} />
      )}
      {removing >= 0 && project && (
        <ConfirmDialog
          title="Kaynağı sil"
          message={`“${sourceLabel(project.sources[removing], removing)}” kaynağının altyazısı, bölümleri ve açıklamaları silinecek. Senaryonuz etkilenmez.`}
          confirmLabel="Sil"
          danger
          onConfirm={confirmRemoveSource}
          onCancel={() => setDialog(null)}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "./lib/api";
import { createAutosaver, type SaveStatus } from "./lib/autosave";
import { exportDoc, type CopyMode } from "./lib/copyExport";
import { fontCss } from "./lib/fonts";
import { processTranscript, type PipelineRun } from "./lib/pipeline";
import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT, LEGACY_SYSTEM_PROMPTS } from "./lib/prompts";
import type { ImageMeta, Insight, Project, ProjectMeta, Segment, Settings } from "./lib/types";
import { ConfirmDialog, TextDialog } from "./components/Dialogs";
import { LeftPane, type ProcState } from "./components/LeftPane";
import { RightPane } from "./components/RightPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";

const DEFAULTS: Settings = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  insightModel: "",
  temperature: 0.3,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  insightPrompt: DEFAULT_INSIGHT_PROMPT,
  uiFont: "Inter",
  readFont: "Source Serif 4",
  writeFont: "Literata",
  fontSize: 17,
  lineHeight: 1.75,
  textWidth: 720,
  splitRatio: 0.5,
  segmentTint: 0.12,
  chunkChars: 6000,
  lastProjectId: "",
};

const IDLE: ProcState = { running: false, phase: null, progress: null, error: null, live: null };
const NEW_TITLES = ["Yeni proje", "Yükleniyor…"];

type Dialog =
  | { kind: "link" }
  | { kind: "rename" }
  | { kind: "delete" }
  | { kind: "clear" }
  | null;

interface Toast { id: number; msg: string; kind: "error" | "info" }

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const settingsRef = useRef(settings);
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const projectRef = useRef<Project | null>(null);
  const getDocRef = useRef<() => any>(() => null);
  const [status, setStatus] = useState<{ s: SaveStatus; err?: string }>({ s: "idle" });
  const [proc, setProc] = useState<ProcState>(IDLE);
  const runRef = useRef<PipelineRun | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openSignal, setOpenSignal] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);

  const saver = useMemo(
    () => createAutosaver<Project>((p) => api.saveProject(p), (s, err) => setStatus({ s, err })),
    [],
  );
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

  const mutate = useCallback(
    (fn: (p: Project) => Project, render = true) => {
      const cur = projectRef.current;
      if (!cur) return;
      const next = fn(cur);
      projectRef.current = next;
      if (render) setProject(next);
      saver.schedule(next);
    },
    [saver],
  );

  const refreshProjects = useCallback(async () => setProjects(await api.listProjects()), []);

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
      if (!s.systemPrompt.trim() || LEGACY_SYSTEM_PROMPTS.includes(s.systemPrompt)) s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
      if (!s.insightPrompt.trim()) s.insightPrompt = DEFAULT_INSIGHT_PROMPT;
      settingsRef.current = s;
      setSettings(s);
      const key = await api.hasApiKey();
      setHasKey(key);
      const list = await api.listProjects();
      setProjects(list);
      const target = list.find((p) => p.id === s.lastProjectId) ?? list[0];
      if (target) {
        const p = await api.loadProject(target.id);
        projectRef.current = p;
        setProject(p);
      }
      setReady(true);
      refreshModels(); // yerel sunucular anahtarsız da çalışabilir
    })().catch((e) => {
      toast(`Başlatma hatası: ${e}`, "error");
      setReady(true);
    });
  }, [refreshModels, toast]);

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

  // ---- İşleme hattı ----
  const cancelRun = useCallback(() => {
    runRef.current?.cancel();
    runRef.current = null;
  }, []);

  const runAi = useCallback(
    async (text: string) => {
      const pid = projectRef.current?.id;
      const s = settingsRef.current;
      if (!s.model) {
        setProc({ ...IDLE, error: "Önce Ayarlar'dan bir model seçin." });
        setShowSettings(true);
        return;
      }
      let latest: Segment[] = [];
      setProc({ running: true, phase: "ai", progress: { done: 0, total: 1 }, error: null, live: [] });
      const run = processTranscript(
        text,
        s,
        (segs) => {
          latest = segs;
          setProc((p) => ({ ...p, live: segs }));
        },
        (progress) => setProc((p) => ({ ...p, progress })),
      );
      runRef.current = run;
      try {
        const segs = await run.promise;
        if (projectRef.current?.id !== pid) return;
        mutate((p) => ({ ...p, segments: segs, insights: [] }));
        setProc(IDLE);
      } catch (e: any) {
        if (projectRef.current?.id !== pid) return;
        if (latest.length) mutate((p) => ({ ...p, segments: latest, insights: [] }));
        const cancelled = e?.message === "İptal edildi";
        setProc({ ...IDLE, error: cancelled ? "İşlem iptal edildi — kısmi sonuç tutuldu." : `AI hatası: ${e?.message ?? e}` });
      } finally {
        if (runRef.current === run) runRef.current = null;
      }
    },
    [mutate],
  );

  const fetchAndProcess = useCallback(
    async (url: string) => {
      const pid = projectRef.current?.id;
      setProc({ running: true, phase: "transcript", progress: null, error: null, live: null });
      try {
        const tr = await api.fetchTranscript(url);
        if (projectRef.current?.id !== pid) return;
        mutate((p) => ({
          ...p,
          url,
          title: NEW_TITLES.includes(p.title) ? tr.title : p.title,
          transcriptRaw: tr.text,
        }));
        refreshProjects();
        toast(`Altyazı alındı (${tr.lang}${tr.auto ? ", otomatik" : ""})`);
        await runAi(tr.text);
      } catch (e: any) {
        if (projectRef.current?.id !== pid) return;
        setProc({ ...IDLE, error: String(e?.message ?? e) });
      }
    },
    [mutate, runAi, refreshProjects, toast],
  );

  // ---- Proje işlemleri ----
  const openProject = useCallback(
    async (id: string) => {
      cancelRun();
      await saver.flush();
      const p = await api.loadProject(id);
      projectRef.current = p;
      setProject(p);
      setProc(IDLE);
      patchSettings({ lastProjectId: id });
    },
    [cancelRun, saver, patchSettings],
  );

  const newBlank = async () => {
    try {
      const p = await api.createProject("Yeni proje", "");
      await refreshProjects();
      await openProject(p.id);
    } catch (e) {
      toast(`Proje oluşturulamadı: ${e}`, "error");
    }
  };

  const newFromLink = async (url: string) => {
    setDialog(null);
    try {
      const p = await api.createProject("Yükleniyor…", url);
      await refreshProjects();
      await openProject(p.id);
      await fetchAndProcess(url);
    } catch (e) {
      toast(`${e}`, "error");
    }
  };

  const renameCurrent = async (title: string) => {
    setDialog(null);
    mutate((p) => ({ ...p, title }));
    setTimeout(refreshProjects, 800);
  };

  const deleteCurrent = async () => {
    setDialog(null);
    const id = projectRef.current?.id;
    if (!id) return;
    cancelRun();
    saver.cancel();
    await api.deleteProject(id);
    const list = await api.listProjects();
    setProjects(list);
    if (list[0]) await openProject(list[0].id);
    else {
      projectRef.current = null;
      setProject(null);
      setProc(IDLE);
    }
  };

  const clearAll = async () => {
    setDialog(null);
    cancelRun();
    saver.cancel();
    try {
      await api.clearAll();
      projectRef.current = null;
      setProject(null);
      setProjects([]);
      setProc(IDLE);
      patchSettings({ lastProjectId: "" });
      toast("Tüm projeler temizlendi");
    } catch (e) {
      toast(`Temizlenemedi: ${e}`, "error");
    }
  };

  // Proje listesi başlığı, kayıttan sonra güncel kalsın
  useEffect(() => {
    if (status.s === "saved") refreshProjects();
  }, [status.s, refreshProjects]);

  // ---- Kopyala ----
  const copy = useCallback(
    async (mode: CopyMode) => {
      const p = projectRef.current;
      if (!p) return toast("Kopyalanacak proje yok", "error");
      const doc = getDocRef.current() ?? p.editorDoc;
      const text = exportDoc(doc, p.imageMeta, mode);
      if (!text.trim()) return toast("Senaryo boş", "error");
      try {
        await writeText(text);
      } catch (e) {
        toast(`Kopyalanamadı: ${e}`, "error");
      }
    },
    [toast],
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

  // ---- Bölme çubuğu ----
  const splitRef = useRef<HTMLDivElement>(null);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = splitRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => patchSettings({ splitRatio: Math.min(0.75, Math.max(0.25, (ev.clientX - box.left) / box.width)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onInsights = useCallback((insights: Insight[]) => mutate((p) => ({ ...p, insights })), [mutate]);
  const onDoc = useCallback((doc: any) => mutate((p) => ({ ...p, editorDoc: doc }), false), [mutate]);
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
        onCopy={copy}
        onSettings={() => setShowSettings(true)}
      />

      {project ? (
        <main className="split" ref={splitRef}>
          <div className="split-left" style={{ width: `${settings.splitRatio * 100}%` }}>
            <LeftPane
              project={project}
              settings={settings}
              models={models}
              proc={proc}
              onInsights={onInsights}
              onReprocess={() => runAi(project.transcriptRaw)}
              onCancel={cancelRun}
              onFetchUrl={(url) => fetchAndProcess(url)}
              onToast={toast}
            />
          </div>
          <div className="divider" onPointerDown={startDrag} />
          <div className="split-right">
            <RightPane key={project.id} project={project} onDoc={onDoc} onMeta={onMeta} onToast={toast} registerGetDoc={registerGetDoc} />
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
        <span className={status.s === "error" ? "err" : "muted"}>{statusText}</span>
        <span className="spacer" />
        <span className="muted">
          {settings.model ? `Model: ${settings.model}` : "Model seçilmedi"} · Ctrl+K proje · Ctrl+Shift+C kopyala
        </span>
      </footer>

      {showSettings && (
        <SettingsDialog
          settings={settings}
          models={models}
          hasKey={hasKey}
          onChange={patchSettings}
          onModels={setModels}
          onKeyChanged={setHasKey}
          onClose={() => setShowSettings(false)}
        />
      )}
      {dialog?.kind === "link" && (
        <TextDialog title="Linkten başlat" label="YouTube video bağlantısı" placeholder="https://www.youtube.com/watch?v=…" confirmLabel="Başlat" onSubmit={newFromLink} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "rename" && project && (
        <TextDialog title="Projeyi yeniden adlandır" initial={project.title} confirmLabel="Kaydet" onSubmit={renameCurrent} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && project && (
        <ConfirmDialog title="Projeyi sil" message={`“${project.title}” ve resimleri kalıcı olarak silinecek.`} confirmLabel="Sil" danger onConfirm={deleteCurrent} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "clear" && (
        <ConfirmDialog title="Tümünü temizle" message="Tüm projeler, scriptler ve kaydedilmiş resimler kalıcı olarak silinecek. Bu işlem geri alınamaz." confirmLabel="Hepsini sil" danger onConfirm={clearAll} onCancel={() => setDialog(null)} />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}

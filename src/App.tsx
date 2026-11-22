import { activeModel, migrateProvider } from "./lib/aiProvider";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { DataSettings } from "./components/DataSettings";
import { UpdateBanner } from "./components/UpdateBanner";
import { ConfirmDialog, TextDialog } from "./components/Dialogs";
import { HomePage } from "./components/HomePage";
import { LeftPane } from "./components/LeftPane";
import { RightPane, type RightTab } from "./components/RightPane";
import { SettingsDialog } from "./components/SettingsDialog";
import { SynthesisDialog } from "./components/SynthesisDialog";
import { SubtitlePicker } from "./components/SubtitlePicker";
import { TopBar } from "./components/TopBar";
import { VideoPanel } from "./components/VideoPanel";
import { usePipeline } from "./hooks/usePipeline";
import { useUpdater } from "./hooks/useUpdater";
import { useVideoStats } from "./hooks/useVideoStats";
import { useProjectStore, type PipelineLifecycle } from "./hooks/useProjectStore";
import { useSplitLayout } from "./hooks/useSplitLayout";
import { api, type ProjectPatch } from "./lib/api";
import { createAutosaver } from "./lib/autosave";
import { exportDoc, type CopyMode } from "./lib/copyExport";
import { emptyPublish } from "./lib/publish";
import { fontCss } from "./lib/fonts";
import { migrateStages } from "./lib/settingsDefaults";
import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT, isLegacyInsightPrompt, isLegacySystemPrompt } from "./lib/prompts";
import { activeSource, patchSource, removeSource, sourceLabel, subtitleLang } from "./lib/sources";
import { exportTimed } from "./lib/timed";
import { refreshWhisper, subscribeWhisper, sttReady, whisperStatus } from "./lib/stt";
import { appShortcutLabels } from "./lib/keys";
import { keysClaimed } from "./lib/keyScope";
import { disfluentWords } from "./lib/disfluency";
import type { ChatMessage, ImageMeta, Insight, PublishMeta, Settings, Synthesis, SynthesisCitation, TimedDoc, VoiceTake } from "./lib/types";
import { videoIdOf } from "./lib/youtube";
import { DEFAULT_SETTINGS } from "./lib/settingsDefaults";

const DEFAULTS = DEFAULT_SETTINGS;

type Dialog =
  | { kind: "link" }
  | { kind: "rename"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "duplicate"; url: string; existingId: string; existingTitle: string }
  | { kind: "clear" }
  | { kind: "removeSource"; id: string }
  | null;

interface Toast { id: number; msg: string; kind: "error" | "info" }

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const settingsRef = useRef(settings);
  const [hasKey, setHasKey] = useState(false);
  const [hasGroqKey, setHasGroqKey] = useState(false);
  const whisper = useSyncExternalStore(subscribeWhisper, whisperStatus);
  /** Ses → yazı kullanılabilir mi (Groq anahtarı ya da indirilmiş yerel model)? */
  const sttOk = useMemo(
    () => sttReady(settings, hasGroqKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.sttEngine, settings.whisperModel, hasGroqKey, whisper],
  );
  const [hasYoutubeKey, setHasYoutubeKey] = useState(false);
  const [view, setView] = useState<"home" | "project">("home");
  const [tab, setTab] = useState<RightTab>("write");
  const [models, setModels] = useState<string[]>([]);
  const getDocRef = useRef<() => any>(() => null);
  const insertRef = useRef<(markdown: string) => boolean>(() => false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [synthesisOpen, setSynthesisOpen] = useState(false);
  const [pendingSeek, setPendingSeek] = useState<{ sourceId: string; t: number } | null>(null);
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

  useEffect(() => {
    const fallback = (event: Event) => toast((event as CustomEvent<string>).detail);
    window.addEventListener("sa-ai-fallback", fallback);
    return () => window.removeEventListener("sa-ai-fallback", fallback);
  }, [toast]);

  const patchSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      settingsSaver.schedule(next);
    },
    [settingsSaver],
  );

  // Proje durumu ile işleme hattı birbirine bağlıdır (proje silinince işlemi durur); kanca ref ile kurulur.
  const lifecycle = useRef<PipelineLifecycle>({ cancel: () => {}, reset: () => {} });
  const { projects, project, projectRef, status, saver, mutate, updateProject, openProject, loadInitial, createProject, deleteById, editProject, clearAll, restoreProject } =
    useProjectStore({ patchSettings, lifecycle });

  const flushAll = useCallback(async () => {
    await Promise.all([saver.flush(), settingsSaver.flush()]);
    const failure = saver.lastError() || settingsSaver.lastError();
    if (failure) throw new Error(failure);
  }, [saver, settingsSaver]);
  const updater = useUpdater(flushAll);

  const restoreFromBackup = async (id: string | null, date: string) => {
    if (id) {
      if (await restoreProject(id, date)) setEditorRevision((rev) => rev + 1);
    } else {
      await flushAll();
      await api.restoreBackup(null, date);
      window.location.reload();
    }
  };
  const pipe = usePipeline({ projectRef, mutate, updateProject, settingsRef, toast, openSettings: () => setShowSettings(true) });
  const videoStats = useVideoStats(projects, ready);
  // Eski sürümlerde bozuk kaydedilmiş başlıklar (�) videonun güncel başlığıyla bir kez onarılır.
  useEffect(() => {
    for (const m of projects) {
      if (!m.title.includes("�")) continue;
      const fixed = m.sources.map((s) => videoStats.stats[videoIdOf(s.url) ?? ""]?.title).find(Boolean);
      if (fixed && fixed !== m.title) editProject(m.id, { title: fixed }).catch(() => {});
    }
  }, [projects, videoStats.stats, editProject]);
  lifecycle.current = {
    cancel: pipe.cancelRun,
    reset: () => {
      pipe.reset();
      setTab("write");
    },
  };

  const refreshModels = useCallback(async () => {
    try {
      const current = settingsRef.current;
      const list = current.aiProvider === "codex"
        ? (await api.codexStatus(current.codexPath)).models
        : await api.listModels(current.baseUrl);
      if (settingsRef.current.aiProvider === current.aiProvider) setModels(list);
    } catch {
      /* sessiz: anahtar/adres henüz girilmemiş olabilir */
    }
  }, []);

  // ---- Açılış ----
  useEffect(() => {
    (async () => {
      const loaded = await api.loadSettings();
      const s: Settings = { ...DEFAULTS, ...loaded, aiProvider: migrateProvider(loaded) };
      if (!Array.isArray(s.stages) || !s.stages.length) s.stages = DEFAULTS.stages;
      else s.stages = migrateStages(s.stages);
      if (!Array.isArray(s.defaultChecklist)) s.defaultChecklist = DEFAULTS.defaultChecklist;
      if (!s.systemPrompt.trim() || isLegacySystemPrompt(s.systemPrompt)) s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
      if (!s.insightPrompt.trim() || isLegacyInsightPrompt(s.insightPrompt)) s.insightPrompt = DEFAULT_INSIGHT_PROMPT;
      settingsRef.current = s;
      setSettings(s);
      void refreshWhisper();
      await loadInitial();
      setReady(true);
      refreshModels(); // yerel sunucular anahtarsız da çalışabilir
    })().catch((e) => {
      toast(`Başlatma hatası: ${e}`, "error");
      setReady(true);
    });
  }, [refreshModels, toast, loadInitial]);

  useEffect(() => {
    if (!ready || settings.aiProvider !== "api") return;
    void api.hasApiKey().then(setHasKey).catch(() => {});
  }, [ready, settings.aiProvider]);

  useEffect(() => {
    if (!ready || settings.sttEngine !== "groq") return;
    void api.hasGroqKey().then(setHasGroqKey).catch(() => {});
  }, [ready, settings.sttEngine]);

  useEffect(() => {
    if (!showSettings && (!ready || settings.statsSource !== "api")) return;
    void api.hasYoutubeKey().then(setHasYoutubeKey).catch(() => {});
  }, [showSettings, ready, settings.statsSource]);

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
  /** Yeni projeye aşama "Fikir" ve varsayılan kontrol listesi verilir. */
  const newProjectExtra = (): ProjectPatch => ({
    stage: settingsRef.current.stages[0]?.id ?? "idea",
    checklist: settingsRef.current.defaultChecklist.map((text) => ({ id: crypto.randomUUID(), text, done: false })),
  });

  const newBlank = async () => {
    try {
      await createProject("Yeni proje", "", newProjectExtra());
      setView("project");
    } catch (e) {
      toast(`Proje oluşturulamadı: ${e}`, "error");
    }
  };

  const startFromLink = async (url: string) => {
    setDialog(null);
    try {
      // Başka bir işlem sürüyorsa yeni proje açılmadan oluşturulur ve sıraya alınır (çalışan iş kesilmez).
      if (pipe.proc.running || pipe.queue.length) {
        const p = await createProject("Yükleniyor…", url, newProjectExtra(), false);
        pipe.fetchForSource(p.sources[0].id, url, undefined, p.id);
        return;
      }
      const p = await createProject("Yükleniyor…", url, newProjectExtra());
      setView("project");
      pipe.fetchForSource(p.sources[0].id, url, undefined, p.id);
    } catch (e) {
      toast(`${e}`, "error");
    }
  };

  /** Aynı video başka projede varsa önce uyarır. */
  const newFromLink = (url: string) => {
    const vid = videoIdOf(url.trim());
    const dup = vid ? projects.find((m) => m.sources.some((s) => videoIdOf(s.url) === vid)) : undefined;
    if (dup) setDialog({ kind: "duplicate", url: url.trim(), existingId: dup.id, existingTitle: dup.title });
    else void startFromLink(url.trim());
  };

  const openFromHome = (id: string) => {
    // Açık proje yeniden yüklenmez: arka plandaki işlem kesilmesin, kaydedilmemiş değişiklik kaybolmasın.
    if (projectRef.current?.id === id) return setView("project");
    openProject(id)
      .then(() => setView("project"))
      .catch((e) => toast(`${e}`, "error"));
  };

  const goHome = useCallback(() => {
    setView("home");
    setSynthesisOpen(false);
    setPendingSeek(null);
    void saver.flush();
  }, [saver]);

  const edit = (id: string, patch: ProjectPatch) => {
    editProject(id, patch).catch((e) => toast(`Kaydedilemedi: ${e}`, "error"));
  };

  const renameProject = (title: string) => {
    const id = dialog?.kind === "rename" ? dialog.id : null;
    setDialog(null);
    if (id) edit(id, { title });
  };

  const deleteProject = async () => {
    const id = dialog?.kind === "delete" ? dialog.id : null;
    setDialog(null);
    if (!id) return;
    try {
      const wasOpen = projectRef.current?.id === id;
      await deleteById(id);
      if (wasOpen) setView("home");
    } catch (e) {
      toast(`Silinemedi: ${e}`, "error");
    }
  };

  const clearEverything = async () => {
    setDialog(null);
    try {
      setSynthesisOpen(false);
      setView("home");
      const path = await clearAll();
      toast(`Tüm projeler temizlendi. Yedek ${path}`);
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
        ? exportTimed(p.timed ?? null, p.imageMeta, mode, disfluentWords(p.timed))
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
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      // Tam ekran video / kare görüntüleyici açıkken uygulama kısayolları çalışmaz.
      if (keysClaimed() === "exclusive") return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpenSignal((n) => n + 1);
      } else if (e.key.toLowerCase() === "h" && (e.metaKey ? e.shiftKey : !e.shiftKey)) {
        e.preventDefault();
        goHome();
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
  }, [copy, goHome]);

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
  const onChat = useCallback(
    (sourceId: string, chat: ChatMessage[]) => mutate((p) => patchSource(p, sourceId, (s) => ({ ...s, chat }))),
    [mutate],
  );
  const onSelectSource = useCallback((id: string) => mutate((p) => (p.activeSourceId === id ? p : { ...p, activeSourceId: id })), [mutate]);
  const onDoc = useCallback((doc: any) => mutate((p) => ({ ...p, editorDoc: doc }), false), [mutate]);
  const onPublish = useCallback((change: (value: PublishMeta) => PublishMeta) => {
    mutate((p) => ({ ...p, publish: { ...change(p.publish ?? emptyPublish()), updatedAt: Date.now() } }));
  }, [mutate]);
  const onTimed = useCallback((doc: TimedDoc) => mutate((p) => ({ ...p, timed: doc })), [mutate]);
  // Arka planda gelen sonuçlar (AI önerileri) en güncel zamanlı metne uygulanır.
  const patchTimed = useCallback(
    (fn: (d: TimedDoc) => TimedDoc) => mutate((p) => (p.timed ? { ...p, timed: fn(p.timed) } : p)),
    [mutate],
  );
  const patchTakes = useCallback(
    (fn: (t: VoiceTake[]) => VoiceTake[]) => mutate((p) => ({ ...p, takes: fn(p.takes ?? []) })),
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

  const registerInsert = useCallback((fn: (markdown: string) => boolean) => { insertRef.current = fn; }, []);
  const closeSynthesis = useCallback(() => setSynthesisOpen(false), []);
  const saveSynthesis = async (run: Synthesis) => {
    if (!project) return;
    await updateProject(project.id, (p) => ({
      ...p,
      syntheses: [run, ...(p.syntheses ?? []).filter((x) => x.id !== run.id)].slice(0, 5),
    }));
    await saver.flush();
  };
  const seekSynthesis = (citation: SynthesisCitation) => {
    onSelectSource(citation.sourceId);
    setPendingSeek({ sourceId: citation.sourceId, t: citation.t });
    closeSynthesis();
  };
  const insertSynthesis = (markdown: string) => {
    if (!insertRef.current(markdown)) {
      toast("Senaryo editöre aktarılamadı.", "error");
      return;
    }
    setTab("write");
    closeSynthesis();
  };
  const clearPendingSeek = useCallback(() => setPendingSeek(null), []);

  const statusText = {
    idle: "",
    pending: "Değişiklikler bekliyor…",
    saving: "Kaydediliyor…",
    saved: "Kaydedildi ✓",
    error: `Kayıt hatası: ${status.err ?? ""}`,
  }[status.s];

  if (!ready) return <div className="boot">Yükleniyor…</div>;

  const showProject = view === "project" && !!project && !!source;
  const dialogMeta = dialog?.kind === "rename" || dialog?.kind === "delete" ? projects.find((m) => m.id === dialog.id) : undefined;

  const removing =
    dialog?.kind === "removeSource" && project ? project.sources.findIndex((s) => s.id === dialog.id) : -1;

  return (
    <div className="app">
      <TopBar
        projects={projects}
        currentId={project?.id ?? null}
        view={showProject ? "project" : "home"}
        stages={settings.stages}
        onHome={goHome}
        onEdit={edit}
        openSignal={openSignal}
        onSelect={openFromHome}
        onNewBlank={newBlank}
        onNewFromLink={() => setDialog({ kind: "link" })}
        onRename={() => project && setDialog({ kind: "rename", id: project.id })}
        onDelete={() => project && setDialog({ kind: "delete", id: project.id })}
        onClearAll={() => setDialog({ kind: "clear" })}
        onSettings={() => setShowSettings(true)}
        onSynthesis={() => setSynthesisOpen(true)}
      />

      <UpdateBanner updater={updater} />
      {showProject && project && source ? (
        <main className="split" ref={splitRef}>
          <div className="split-left" style={{ width: `${(hasVideoPane ? L : settings.splitRatio) * 100}%` }}>
            <LeftPane
              project={project}
              settings={settings}
              models={models}
              proc={pipe.proc}
              queued={pipe.queue.some((j) => j.sourceId === source.id)}
              onDequeue={() => pipe.dequeue(source.id)}
              onInsights={onInsights}
              onChat={onChat}
              onReprocess={pipe.reprocess}
              onCustomRun={pipe.customRun}
              onEditText={pipe.editText}
              onCancel={pipe.cancel}
              onResume={pipe.resume}
              onFetchUrl={pipe.fetchActive}
              onSelectSource={onSelectSource}
              onAddSource={pipe.addSourceFromUrl}
              onFetchText={pipe.textActive}
              onAddTextSource={pipe.addSourceFromText}
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
                  pendingSeek={pendingSeek?.sourceId === source.id ? pendingSeek.t : null}
                  onSeeked={clearPendingSeek}
                  transcriptRaw={source.transcriptRaw}
                  origLang={subtitleLang(source)}
                  segments={source.segments}
                  chaptersTr={source.chaptersTr}
                  onChaptersTr={(v) => mutate((p) => patchSource(p, source.id, (x) => ({ ...x, chaptersTr: v })))}
                  settings={settings}
                  onToast={toast}
                />
              </div>
              <div className="divider" onPointerDown={startDrag("right")} />
            </>
          )}
          <div className="split-right">
            <RightPane
              key={`${project.id}-${editorRevision}`}
              project={project}
              tab={tab}
              onTab={setTab}
              settings={settings}
              sttOk={sttOk}
              onOpenSettings={() => setShowSettings(true)}
              onDoc={onDoc}
              onTimed={onTimed}
              onPatchTimed={patchTimed}
              onPatchTakes={patchTakes}
              onMeta={onMeta}
              onToast={toast}
              registerGetDoc={registerGetDoc}
              registerInsert={registerInsert}
              onCopy={copy}
              onCount={setWordCount}
              onPublish={onPublish}
              onPublishWpm={(publishWpm) => patchSettings({ publishWpm })}
            />
          </div>
        </main>
      ) : (
        <HomePage
          projects={projects}
          settings={settings}
          runningId={pipe.proc.running ? pipe.proc.projectId : null}
          queuedIds={pipe.queue.map((j) => j.projectId)}
          videoStats={videoStats}
          onOpen={openFromHome}
          onNewFromLink={() => setDialog({ kind: "link" })}
          onNewBlank={newBlank}
          onEdit={edit}
          onRename={(id) => setDialog({ kind: "rename", id })}
          onDelete={(id) => setDialog({ kind: "delete", id })}
          onSettings={patchSettings}
          focusSignal={openSignal}
        />
      )}

      <footer className="statusbar">
        <span className="muted">
          {activeModel(settings) ? `Model: ${activeModel(settings)}` : "Model seçilmedi"} · {appShortcutLabels.projects} proje · {appShortcutLabels.home} ana sayfa · {appShortcutLabels.copy} kopyala
        </span>
        <span className="spacer" />
        {showProject && (
          <span className={"status-save " + (status.s === "error" ? "err" : status.s === "saved" || status.s === "idle" ? "ok" : "muted")}>
            {statusText || "Kaydedildi ✓"}
          </span>
        )}
        {showProject && wordCount && <span className="status-count muted tnum">{wordCount}</span>}
      </footer>

      {showProject && project && synthesisOpen && (
        <SynthesisDialog key={project.id} project={project} settings={settings} saveRun={saveSynthesis} close={closeSynthesis} seek={seekSynthesis} insert={insertSynthesis} />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          models={models}
          hasKey={hasKey}
          hasGroqKey={hasGroqKey}
          hasYoutubeKey={hasYoutubeKey}
          onChange={patchSettings}
          onModels={setModels}
          onKeyChanged={setHasKey}
          onGroqKeyChanged={setHasGroqKey}
          onYoutubeKeyChanged={setHasYoutubeKey}
          dataSettings={<DataSettings projects={projects} activeId={project?.id ?? null} restore={restoreFromBackup} updater={updater} />}
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
      {dialog?.kind === "rename" && dialogMeta && (
        <TextDialog title="Projeyi yeniden adlandır" initial={dialogMeta.title} confirmLabel="Kaydet" onSubmit={renameProject} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "duplicate" && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setDialog(null)}>
          <div className="modal small-modal">
            <div className="modal-head"><span className="modal-title">Bu video zaten bir projede</span></div>
            <div className="modal-body">
              <p>Bu video “{dialog.existingTitle}” projesinde var. Yine de yeni bir proje oluşturulsun mu?</p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDialog(null)}>Vazgeç</button>
              <button className="btn" onClick={() => (setDialog(null), openFromHome(dialog.existingId))}>O projeyi aç</button>
              <button className="btn primary" onClick={() => void startFromLink(dialog.url)} autoFocus>Yine de oluştur</button>
            </div>
          </div>
        </div>
      )}
      {dialog?.kind === "delete" && dialogMeta && (
        <ConfirmDialog title="Projeyi sil" message={`“${dialogMeta.title}”, resimleri ve ses kayıtları kalıcı olarak silinecek.`} confirmLabel="Sil" danger onConfirm={deleteProject} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === "clear" && (
        <ConfirmDialog title="Tümünü temizle" message="Projeler, resimler ve ses kayıtları önce ZIP arşivine yedeklenir, ardından listeden kaldırılır." confirmLabel="Hepsini sil" danger onConfirm={clearEverything} onCancel={() => setDialog(null)} />
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

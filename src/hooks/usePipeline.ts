import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, type SubOption, type SubtitleList } from "../lib/api";
import { advanceStage } from "../lib/home";
import { PipelineError, processTranscript, type PipelineRun, type ResumeState } from "../lib/pipeline";
import { buildCustomRunSystemPrompt } from "../lib/prompts";
import { segmentsToMarkdown } from "../lib/segmentParser";
import { activeSource, addSource, applyProcessed, makeSource, NEW_TITLES, patchSource, restoreHistory } from "../lib/sources";
import type { Project, ProcState, Segment, Settings } from "../lib/types";

export const IDLE: ProcState = { running: false, phase: null, progress: null, error: null, live: null, sourceId: null, resumable: false };

/** Seçim bekleyen altyazı listesi (hangi kaynak için istendiği ile birlikte). */
export interface SubPick {
  sourceId: string;
  url: string;
  list: SubtitleList;
}

interface Resumable {
  projectId: string;
  sourceId: string;
  label: string;
  state: ResumeState;
  /** Önceki sürüm bu işleme için zaten geçmişe eklendi mi (devam sonucunda tekrar eklenmesin). */
  historyPushed: boolean;
}

interface Opts {
  projectRef: MutableRefObject<Project | null>;
  mutate: (fn: (p: Project) => Project, render?: boolean) => void;
  settingsRef: MutableRefObject<Settings>;
  toast: (msg: string, kind?: "error" | "info") => void;
  openSettings: () => void;
}

/**
 * Altyazı çekme ve AI ile işleme hattı. Her işlem başladığı projeye ve kaynağa yazar;
 * kullanıcı sekme/proje değiştirse de sonuç yanlış yere gitmez. Aynı anda tek işlem çalışır.
 */
export function usePipeline({ projectRef, mutate, settingsRef, toast, openSettings }: Opts) {
  const [proc, setProc] = useState<ProcState>(IDLE);
  const procRef = useRef(proc);
  procRef.current = proc;
  const [subPick, setSubPick] = useState<SubPick | null>(null);
  const runRef = useRef<PipelineRun | null>(null);
  const resumeRef = useRef<Resumable | null>(null);
  /** İptal edilemeyen bekleyen işlemler (altyazı çekme/liste) için jeton: değişirse sonuç yok sayılır. */
  const opRef = useRef(0);

  /** Otomatik aşama (ayar açıksa): proje hâlâ açıksa aşamayı yalnızca ileri taşır. */
  const bumpStage = useCallback(
    (pid: string | undefined, target: string) => {
      const st = settingsRef.current;
      if (!st.autoStage || !pid || projectRef.current?.id !== pid) return;
      mutate((p) => {
        const to = advanceStage(st.stages, p.stage, target);
        return to ? { ...p, stage: to } : p;
      });
    },
    [projectRef, mutate, settingsRef],
  );

  /** Proje değişimi/silme için: çalışan her şeyi geçersiz kıl. */
  const cancelRun = useCallback(() => {
    opRef.current++;
    runRef.current?.cancel();
    runRef.current = null;
    resumeRef.current = null;
  }, []);

  const reset = useCallback(() => {
    setSubPick(null);
    setProc(IDLE);
  }, []);

  /** Kullanıcı İptal'e bastı. AI çalışıyorsa kısmi sonuç tutulur; altyazı aşamasında sonuç yok sayılır. */
  const cancel = useCallback(() => {
    if (runRef.current) runRef.current.cancel();
    else {
      opRef.current++;
      setProc(IDLE);
    }
  }, []);

  const run = useCallback(
    async (sourceId: string, text: string, o: { label: string; customPrompt?: string; resume?: Resumable }) => {
      const pid = projectRef.current?.id;
      if (!pid) return;
      let s: Settings = settingsRef.current;
      if (!o.resume) {
        // Özel istem: temel sistem istemi korunur, kullanıcının istemi ek talimat olarak eklenir.
        if (o.customPrompt) s = { ...s, systemPrompt: buildCustomRunSystemPrompt(s.systemPrompt, o.customPrompt) };
        if (!s.model) {
          setProc({ ...IDLE, sourceId, error: "Önce Ayarlar'dan bir model seçin." });
          openSettings();
          return;
        }
      }
      resumeRef.current = null;
      setProc({ running: true, phase: "ai", progress: { done: 0, total: 1 }, error: null, live: [], sourceId, resumable: false });
      const pipeline = processTranscript(
        text,
        s,
        (segs: Segment[]) => setProc((p) => ({ ...p, live: segs })),
        (progress) => setProc((p) => ({ ...p, progress })),
        { resume: o.resume?.state },
      );
      runRef.current = pipeline;
      let historyPushed = o.resume?.historyPushed ?? false;
      // Proje değiştiyse ya da kaynak silindiyse sonuç yazılmaz.
      const gone = () => projectRef.current?.id !== pid || !projectRef.current.sources.some((x) => x.id === sourceId);
      try {
        const segs = await pipeline.promise;
        if (gone()) return;
        mutate((p) => patchSource(p, sourceId, (src) => applyProcessed(src, segs, o.label, Date.now(), historyPushed)));
        bumpStage(pid, "processed");
        setProc(IDLE);
      } catch (e: any) {
        if (gone()) return;
        const pe = e instanceof PipelineError ? e : null;
        const partial = pe?.partial ?? [];
        if (partial.length) {
          const keep = historyPushed;
          mutate((p) => patchSource(p, sourceId, (src) => applyProcessed(src, partial, o.label, Date.now(), keep)));
          historyPushed = true;
        }
        if (pe) resumeRef.current = { projectId: pid, sourceId, label: o.label, state: pe.resume, historyPushed };
        setProc({
          ...IDLE,
          sourceId,
          resumable: !!pe,
          error: pe?.cancelled ? "İşlem iptal edildi — kısmi sonuç tutuldu." : `AI hatası: ${e?.message ?? e}`,
        });
      } finally {
        if (runRef.current === pipeline) runRef.current = null;
      }
    },
    [projectRef, mutate, settingsRef, openSettings, bumpStage],
  );

  /** Hata/iptal sonrası kaldığı parçadan devam eder. */
  const resume = useCallback(() => {
    const r = resumeRef.current;
    if (!r || r.projectId !== projectRef.current?.id) return;
    void run(r.sourceId, r.state.transcript, { label: r.label, resume: r });
  }, [projectRef, run]);

  /** Altyazıyı al (sıra: İngilizce > Türkçe > diğer) ve AI ile işle. */
  const fetchForSource = useCallback(
    async (sourceId: string, url: string, manualTitle?: string) => {
      const pid = projectRef.current?.id;
      const token = ++opRef.current;
      setSubPick(null);
      setProc({ ...IDLE, running: true, phase: "transcript", sourceId });
      // Başarısız olsa da kaynak bağlantısını hatırlasın (Yeniden dene).
      mutate((p) => patchSource(p, sourceId, (s) => (s.url === url ? s : { ...s, url })));
      try {
        const tr = await api.fetchDefaultTranscript(url);
        if (opRef.current !== token || projectRef.current?.id !== pid) return;
        const title = manualTitle?.trim() || tr.title?.trim() || "";
        mutate((p) => {
          const q = patchSource(p, sourceId, (s) => ({ ...s, url, transcriptRaw: tr.text, title: manualTitle?.trim() || s.title.trim() || title }));
          return title && NEW_TITLES.includes(q.title) ? { ...q, title } : q;
        });
        bumpStage(pid, "subs");
        toast(`Altyazı alındı (${tr.lang})`);
        await run(sourceId, tr.text, { label: `Altyazı: ${tr.lang}` });
      } catch (e: any) {
        if (opRef.current !== token || projectRef.current?.id !== pid) return;
        setProc({ ...IDLE, sourceId, error: String(e?.message ?? e) });
      }
    },
    [projectRef, mutate, run, toast, bumpStage],
  );

  /** Etkin kaynağın altyazısını varsayılan istemle yeniden işler (altyazı yoksa bağlantıdan yeniden çeker). */
  const reprocess = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    const src = activeSource(p);
    if (src.transcriptRaw) void run(src.id, src.transcriptRaw, { label: "Varsayılan istem" });
    else if (src.url.trim()) void fetchForSource(src.id, src.url.trim());
  }, [projectRef, run, fetchForSource]);

  const customRun = useCallback(
    (prompt: string) => {
      const p = projectRef.current;
      if (!p) return;
      const src = activeSource(p);
      void run(src.id, src.transcriptRaw || segmentsToMarkdown(src.segments), { label: "Özel istem", customPrompt: prompt });
    },
    [projectRef, run],
  );

  /** Etkin kaynak boşsa (ilk bağlantı) onu kullanır. */
  const fetchActive = useCallback(
    (url: string, title?: string) => {
      const p = projectRef.current;
      if (p) void fetchForSource(activeSource(p).id, url, title);
    },
    [projectRef, fetchForSource],
  );

  /** Yeni kaynak ekler, etkinleştirir ve altyazısını çekip işler. */
  const addSourceFromUrl = useCallback(
    (url: string, title?: string) => {
      const src = makeSource(url, title?.trim() ?? "");
      mutate((p) => addSource(p, src));
      void fetchForSource(src.id, url, title);
    },
    [mutate, fetchForSource],
  );

  /** "Başka altyazı seç…": etkin kaynağın altyazı listesini getirir ve seçici açar. */
  const pickSubtitle = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    const src = activeSource(p);
    if (!src.url.trim()) return toast("Bu kaynağın video bağlantısı yok", "error");
    const pid = p.id;
    const token = ++opRef.current;
    setProc({ ...IDLE, running: true, phase: "subs", sourceId: src.id });
    try {
      const list = await api.listSubtitles(src.url);
      if (opRef.current !== token || projectRef.current?.id !== pid) return;
      setProc(IDLE);
      if (!list.options.length) return toast("Bu videoda altyazı bulunamadı", "error");
      setSubPick({ sourceId: src.id, url: src.url, list });
    } catch (e: any) {
      if (opRef.current !== token || projectRef.current?.id !== pid) return;
      setProc({ ...IDLE, sourceId: src.id, error: String(e?.message ?? e) });
    }
  }, [projectRef, toast]);

  /** Seçilen altyazıyı indirir, kaynağın altyazısı yapar ve AI ile işler (önceki sürüm geçmişe girer). */
  const downloadSubtitle = useCallback(
    async (opt: SubOption) => {
      const pick = subPick;
      if (!pick) return;
      const pid = projectRef.current?.id;
      const token = ++opRef.current;
      setSubPick(null);
      setProc({ ...IDLE, running: true, phase: "transcript", sourceId: pick.sourceId });
      try {
        const tr = await api.fetchTranscript(pick.url, opt.lang, opt.auto);
        if (opRef.current !== token || projectRef.current?.id !== pid) return;
        mutate((p) => patchSource(p, pick.sourceId, (s) => ({ ...s, transcriptRaw: tr.text, title: s.title.trim() || pick.list.title })));
        bumpStage(pid, "subs");
        toast(`Altyazı alındı (${tr.lang}${tr.auto ? ", otomatik" : ""})`);
        await run(pick.sourceId, tr.text, { label: `Altyazı: ${tr.lang}${tr.auto ? " (otomatik)" : ""}` });
      } catch (e: any) {
        if (opRef.current !== token || projectRef.current?.id !== pid) return;
        setProc({ ...IDLE, sourceId: pick.sourceId, error: String(e?.message ?? e) });
      }
    },
    [subPick, projectRef, mutate, run, toast, bumpStage],
  );

  /** Geçmişteki bir işleme sürümünü geri getirir (mevcut sürüm onunla yer değiştirir). */
  const restoreVersion = useCallback(
    (index: number) => {
      const p = projectRef.current;
      if (!p) return;
      mutate((q) => patchSource(q, activeSource(q).id, (s) => restoreHistory(s, index)));
    },
    [projectRef, mutate],
  );

  /** Silinen kaynağın işlemi sürüyorsa durdurur. */
  const abortSource = useCallback(
    (sourceId: string) => {
      if (procRef.current.sourceId !== sourceId) return;
      cancelRun();
      setProc(IDLE);
    },
    [cancelRun],
  );

  // Pencere kapanırken çalışan işlem iptal edilsin.
  useEffect(() => () => runRef.current?.cancel(), []);

  return {
    proc,
    subPick,
    setSubPick,
    cancelRun,
    reset,
    cancel,
    resume,
    reprocess,
    customRun,
    fetchActive,
    fetchForSource,
    addSourceFromUrl,
    pickSubtitle,
    downloadSubtitle,
    restoreVersion,
    abortSource,
  };
}

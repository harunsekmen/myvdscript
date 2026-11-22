import { activeModel, providerOptions } from "../lib/aiProvider";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, streamChat, type SubOption, type SubtitleList } from "../lib/api";
import { advanceStage } from "../lib/home";
import { PipelineError, processTranscript, type PipelineRun, type ResumeState } from "../lib/pipeline";
import { buildEditMessage, EDIT_SYSTEM_PROMPT } from "../lib/prompts";
import { parseSegments, segmentsToMarkdown } from "../lib/segmentParser";
import {
  activeSource,
  addSource,
  applyProcessed,
  makeSource,
  NEW_TITLES,
  patchSource,
  restoreHistory,
  titleFromText,
  withPastedText,
} from "../lib/sources";
import type { Project, ProcState, Segment, Settings } from "../lib/types";

export const IDLE: ProcState = { running: false, phase: null, progress: null, error: null, live: null, sourceId: null, projectId: null, resumable: false };

/** Seçim bekleyen altyazı listesi (hangi kaynak için istendiği ile birlikte). */
export interface SubPick {
  projectId: string;
  sourceId: string;
  url: string;
  list: SubtitleList;
}

/** Sırada bekleyen "altyazıyı çek ve işle" işi. */
export interface QueuedJob {
  projectId: string;
  sourceId: string;
  url: string;
  title?: string;
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
  /** Açık olsun olmasın bir projeyi günceller (açık değilse diskte). */
  updateProject: (id: string, fn: (p: Project) => Project) => Promise<void>;
  settingsRef: MutableRefObject<Settings>;
  toast: (msg: string, kind?: "error" | "info") => void;
  openSettings: () => void;
}

/**
 * Altyazı çekme ve AI ile işleme hattı. Her işlem başladığı projeye ve kaynağa yazar; kullanıcı
 * başka projeye geçse ya da ana sayfaya dönse de arka planda sürer. Aynı anda tek işlem çalışır;
 * meşgulken başlatılan bağlantılar sıraya alınır ve sırayla işlenir.
 */
export function usePipeline({ projectRef, mutate, updateProject, settingsRef, toast, openSettings }: Opts) {
  const [proc, setProc] = useState<ProcState>(IDLE);
  const procRef = useRef(proc);
  procRef.current = proc;
  const [subPick, setSubPick] = useState<SubPick | null>(null);
  const [queue, setQueue] = useState<QueuedJob[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const runRef = useRef<PipelineRun | null>(null);
  const resumeRef = useRef<Resumable | null>(null);
  /** İptal edilemeyen bekleyen işlemler (altyazı çekme/liste) için jeton: değişirse sonuç yok sayılır. */
  const opRef = useRef(0);

  const setQ = (q: QueuedJob[]) => {
    queueRef.current = q;
    setQueue(q);
  };

  /** Otomatik aşama (ayar açıksa): aşamayı yalnızca ileri taşır; proje açık olmasa da. */
  const bumpStage = useCallback(
    (pid: string, target: string) => {
      const st = settingsRef.current;
      if (!st.autoStage) return;
      void updateProject(pid, (p) => {
        const to = advanceStage(st.stages, p.stage, target);
        return to ? { ...p, stage: to } : p;
      }).catch(() => {});
    },
    [updateProject, settingsRef],
  );

  /** Kaynak (açık projede) silindiyse sonuç yazılmaz. Açık olmayan projede patchSource zaten yok sayar. */
  const sourceGone = useCallback(
    (pid: string, sourceId: string) => {
      const p = projectRef.current;
      return !!p && p.id === pid && !p.sources.some((x) => x.id === sourceId);
    },
    [projectRef],
  );

  /** Proje silme/temizleme için: o projenin (ya da hepsinin) çalışan ve sıradaki işlerini durdur. */
  const cancelRun = useCallback((projectId?: string) => {
    setQ(projectId ? queueRef.current.filter((j) => j.projectId !== projectId) : []);
    const cur = procRef.current;
    if (projectId && cur.projectId !== projectId) return;
    opRef.current++;
    runRef.current?.cancel();
    runRef.current = null;
    resumeRef.current = null;
    if (cur.running) setProc(IDLE);
  }, []);

  /** Proje açılınca: başka projenin hata/seçici durumu temizlenir, çalışan işlem sürer. */
  const reset = useCallback(() => {
    setSubPick(null);
    setProc((p) => (p.running ? p : IDLE));
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
    async (pid: string, sourceId: string, text: string, o: { label: string; resume?: Resumable }) => {
      const s: Settings = settingsRef.current;
      if (!o.resume) {
        if (!activeModel(s)) {
          setProc({ ...IDLE, sourceId, projectId: pid, error: "Önce Ayarlar'dan bir model seçin." });
          openSettings();
          return;
        }
      }
      resumeRef.current = null;
      setProc({ running: true, phase: "ai", progress: { done: 0, total: 1 }, error: null, live: [], sourceId, projectId: pid, resumable: false });
      const pipeline = processTranscript(
        text,
        s,
        (segs: Segment[]) => setProc((p) => ({ ...p, live: segs })),
        (progress) => setProc((p) => ({ ...p, progress })),
        { resume: o.resume?.state },
      );
      runRef.current = pipeline;
      let historyPushed = o.resume?.historyPushed ?? false;
      try {
        const segs = await pipeline.promise;
        if (sourceGone(pid, sourceId)) return setProc(IDLE);
        await updateProject(pid, (p) => patchSource(p, sourceId, (src) => applyProcessed(src, segs, o.label, Date.now(), historyPushed)));
        bumpStage(pid, "processed");
        setProc(IDLE);
      } catch (e: any) {
        if (sourceGone(pid, sourceId)) return setProc(IDLE);
        const pe = e instanceof PipelineError ? e : null;
        const partial = pe?.partial ?? [];
        if (partial.length) {
          const keep = historyPushed;
          await updateProject(pid, (p) => patchSource(p, sourceId, (src) => applyProcessed(src, partial, o.label, Date.now(), keep))).catch(() => {});
          historyPushed = true;
        }
        if (pe) resumeRef.current = { projectId: pid, sourceId, label: o.label, state: pe.resume, historyPushed };
        setProc({
          ...IDLE,
          sourceId,
          projectId: pid,
          resumable: !!pe,
          error: pe?.cancelled ? "İşlem iptal edildi — kısmi sonuç tutuldu." : `AI hatası: ${e?.message ?? e}`,
        });
      } finally {
        if (runRef.current === pipeline) runRef.current = null;
      }
    },
    [settingsRef, openSettings, bumpStage, updateProject, sourceGone],
  );

  /** Açık projenin etkin kaynağı için AI işlemesi. */
  const runActive = useCallback(
    (sourceId: string, text: string, o: { label: string; resume?: Resumable }) => {
      const pid = projectRef.current?.id;
      if (pid) void run(pid, sourceId, text, o);
    },
    [projectRef, run],
  );

  /** Hata/iptal sonrası kaldığı parçadan devam eder. */
  const resume = useCallback(() => {
    const r = resumeRef.current;
    if (!r || r.projectId !== projectRef.current?.id) return;
    void run(r.projectId, r.sourceId, r.state.transcript, { label: r.label, resume: r });
  }, [projectRef, run]);

  /** Altyazıyı al (sıra: İngilizce > Türkçe > diğer) ve AI ile işle. Kuyruğu yok sayar; çağıran meşguliyeti kontrol eder. */
  const startFetch = useCallback(
    async ({ projectId: pid, sourceId, url, title: manualTitle }: QueuedJob) => {
      const token = ++opRef.current;
      setSubPick(null);
      setProc({ ...IDLE, running: true, phase: "transcript", sourceId, projectId: pid });
      try {
        // Başarısız olsa da kaynak bağlantısını hatırlasın (Yeniden dene).
        await updateProject(pid, (p) => patchSource(p, sourceId, (s) => (s.url === url ? s : { ...s, url })));
        const tr = await api.fetchDefaultTranscript(url);
        if (opRef.current !== token) return;
        const title = manualTitle?.trim() || tr.title?.trim() || "";
        await updateProject(pid, (p) => {
          const q = patchSource(p, sourceId, (s) => ({ ...s, url, transcriptRaw: tr.text, title: manualTitle?.trim() || s.title.trim() || title }));
          return title && NEW_TITLES.includes(q.title) ? { ...q, title } : q;
        });
        if (opRef.current !== token) return;
        toast(projectRef.current?.id === pid ? `Altyazı alındı (${tr.lang})` : `“${title || url}” altyazısı alındı, işleniyor`);
        await run(pid, sourceId, tr.text, { label: `Altyazı: ${tr.lang}` });
      } catch (e: any) {
        if (opRef.current !== token) return;
        setProc({ ...IDLE, sourceId, projectId: pid, error: String(e?.message ?? e) });
      }
    },
    [updateProject, run, toast, projectRef],
  );

  /** Bağlantıdan altyazı çekip işler; başka işlem sürüyorsa sıraya alır. */
  const fetchForSource = useCallback(
    (sourceId: string, url: string, title?: string, projectId?: string) => {
      const pid = projectId ?? projectRef.current?.id;
      if (!pid) return;
      const job: QueuedJob = { projectId: pid, sourceId, url, title };
      if (procRef.current.running || queueRef.current.length) {
        if (queueRef.current.some((j) => j.sourceId === sourceId)) return toast("Bu bağlantı zaten sırada");
        setQ([...queueRef.current, job]);
        toast(`Sıraya eklendi (${queueRef.current.length}. sırada); önceki işlem bitince başlayacak`);
        return;
      }
      void startFetch(job);
    },
    [projectRef, startFetch, toast],
  );

  // Çalışan işlem bitince (başarılı, hatalı ya da iptal) sıradaki iş başlar.
  useEffect(() => {
    if (proc.running || !queue.length) return;
    const [next, ...rest] = queue;
    setQ(rest);
    void startFetch(next);
  }, [proc.running, queue, startFetch]);

  /** Sıradaki bir işi çıkarır. */
  const dequeue = useCallback((sourceId: string) => setQ(queueRef.current.filter((j) => j.sourceId !== sourceId)), []);

  /** Etkin kaynağın altyazısını varsayılan istemle yeniden işler (altyazı yoksa bağlantıdan yeniden çeker). */
  const reprocess = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    const src = activeSource(p);
    if (src.transcriptRaw) runActive(src.id, src.transcriptRaw, { label: "Varsayılan istem" });
    else if (src.url.trim()) fetchForSource(src.id, src.url.trim());
  }, [projectRef, runActive, fetchForSource]);

  const customRun = useCallback(
    async (prompt: string) => {
      const p = projectRef.current;
      if (!p || procRef.current.running || !prompt.trim()) return;
      const src = activeSource(p);
      if (!src.segments.length) return;
      const cfg = settingsRef.current;
      if (!activeModel(cfg)) { openSettings(); return; }
      resumeRef.current = null;
      setProc({ ...IDLE, running: true, phase: "ai", progress: { done: 0, total: 1 }, sourceId: src.id, projectId: p.id });
      const handle = streamChat({
        ...providerOptions(cfg),
        system: EDIT_SYSTEM_PROMPT,
        user: buildEditMessage(segmentsToMarkdown(src.segments), src.transcriptRaw, prompt),
        onText: () => {},
      });
      let cancelled = false;
      const job: PipelineRun = { promise: handle.done.then(parseSegments), cancel: () => { cancelled = true; handle.cancel(); } };
      runRef.current = job;
      try {
        const result = await job.promise;
        if (runRef.current !== job) return;
        if (cancelled) throw new Error("İptal edildi");
        if (!result.length || !result.some((s) => s.text.trim())) throw new Error("AI boş metin döndürdü");
        if (!sourceGone(p.id, src.id)) await updateProject(p.id, (q) => patchSource(q, src.id, (s) => applyProcessed(s, result, "AI ile düzenleme")));
        setProc(IDLE);
      } catch (e: any) {
        if (runRef.current !== job) return;
        setProc({ ...IDLE, sourceId: src.id, projectId: p.id, error: `${e?.message ?? e} — mevcut metin korundu.` });
      } finally {
        if (runRef.current === job) runRef.current = null;
      }
    },
    [projectRef, settingsRef, openSettings, updateProject, sourceGone],
  );

  const editText = useCallback((sourceId: string, segments: Segment[]) => {
    if (procRef.current.running) return;
    mutate((p) => patchSource(p, sourceId, (s) => applyProcessed(s, segments, "Hızlı metin düzeltme")));
  }, [mutate]);

  /** Etkin kaynak boşsa (ilk bağlantı) onu kullanır. */
  const fetchActive = useCallback(
    (url: string, title?: string) => {
      const p = projectRef.current;
      if (p) fetchForSource(activeSource(p).id, url, title);
    },
    [projectRef, fetchForSource],
  );

  /** Yeni kaynak ekler, etkinleştirir ve altyazısını çekip işler. */
  const addSourceFromUrl = useCallback(
    (url: string, title?: string) => {
      const src = makeSource(url, title?.trim() ?? "");
      mutate((p) => addSource(p, src));
      fetchForSource(src.id, url, title);
    },
    [mutate, fetchForSource],
  );

  /** Yapıştırılan metni AI'a göndermeden, olduğu gibi kaynağın metni yapar; proje adı yoksa başlığı alır. */
  const putText = (p: Project, sourceId: string, text: string, title?: string): Project => {
    const name = title?.trim() || titleFromText(text);
    const q = patchSource(p, sourceId, (s) => withPastedText(s, text, name));
    return name && NEW_TITLES.includes(q.title) ? { ...q, title: name } : q;
  };

  /** Etkin (boş) kaynağa yapıştırılan metni yazar. */
  const textActive = useCallback(
    (text: string, title?: string) => {
      if (!text.trim()) return;
      mutate((p) => putText(p, activeSource(p).id, text, title));
    },
    [mutate],
  );

  /** Yapıştırılan metinle yeni kaynak ekler ve etkinleştirir. */
  const addSourceFromText = useCallback(
    (text: string, title?: string) => {
      if (!text.trim()) return;
      const src = makeSource("", "");
      mutate((p) => putText(addSource(p, src), src.id, text, title));
    },
    [mutate],
  );

  /** "Başka altyazı seç…": etkin kaynağın altyazı listesini getirir ve seçici açar. */
  const pickSubtitle = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    const src = activeSource(p);
    if (!src.url.trim()) return toast("Bu kaynağın video bağlantısı yok", "error");
    const pid = p.id;
    const token = ++opRef.current;
    setProc({ ...IDLE, running: true, phase: "subs", sourceId: src.id, projectId: pid });
    try {
      const list = await api.listSubtitles(src.url);
      if (opRef.current !== token) return;
      setProc(IDLE);
      if (!list.options.length) return toast("Bu videoda altyazı bulunamadı", "error");
      if (projectRef.current?.id === pid) setSubPick({ projectId: pid, sourceId: src.id, url: src.url, list });
    } catch (e: any) {
      if (opRef.current !== token) return;
      setProc({ ...IDLE, sourceId: src.id, projectId: pid, error: String(e?.message ?? e) });
    }
  }, [projectRef, toast]);

  /** Seçilen altyazıyı indirir, kaynağın altyazısı yapar ve AI ile işler (önceki sürüm geçmişe girer). */
  const downloadSubtitle = useCallback(
    async (opt: SubOption) => {
      const pick = subPick;
      if (!pick) return;
      const pid = pick.projectId;
      const token = ++opRef.current;
      setSubPick(null);
      setProc({ ...IDLE, running: true, phase: "transcript", sourceId: pick.sourceId, projectId: pid });
      try {
        const tr = await api.fetchTranscript(pick.url, opt.lang, opt.auto);
        if (opRef.current !== token) return;
        await updateProject(pid, (p) => patchSource(p, pick.sourceId, (s) => ({ ...s, transcriptRaw: tr.text, title: s.title.trim() || pick.list.title })));
        toast(`Altyazı alındı (${tr.lang}${tr.auto ? ", otomatik" : ""})`);
        await run(pid, pick.sourceId, tr.text, { label: `Altyazı: ${tr.lang}${tr.auto ? " (otomatik)" : ""}` });
      } catch (e: any) {
        if (opRef.current !== token) return;
        setProc({ ...IDLE, sourceId: pick.sourceId, projectId: pid, error: String(e?.message ?? e) });
      }
    },
    [subPick, updateProject, run, toast],
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

  /** Silinen kaynağın işlemi sürüyorsa durdurur, sıradaysa çıkarır. */
  const abortSource = useCallback(
    (sourceId: string) => {
      dequeue(sourceId);
      if (procRef.current.sourceId !== sourceId) return;
      opRef.current++;
      runRef.current?.cancel();
      runRef.current = null;
      resumeRef.current = null;
      setProc(IDLE);
    },
    [dequeue],
  );

  // Pencere kapanırken çalışan işlem iptal edilsin.
  useEffect(() => () => runRef.current?.cancel(), []);

  return {
    proc,
    queue,
    subPick,
    setSubPick,
    cancelRun,
    reset,
    cancel,
    resume,
    reprocess,
    customRun,
    editText,
    fetchActive,
    fetchForSource,
    dequeue,
    addSourceFromUrl,
    addSourceFromText,
    textActive,
    pickSubtitle,
    downloadSubtitle,
    restoreVersion,
    abortSource,
  };
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { VOICE_RECORD_EVENT, buildTimeline, fmtDur, groupTakes, locate, moveTake, takesText, takesToTimed, takeTitle, type TimelineItem } from "../lib/voice";
import { forgetTakes, loadTake, mergeToWav, peaksOf, primeTake, Recording, VoicePlayer } from "../lib/voiceAudio";
import type { Project, Settings, TimedDoc, VoiceTake } from "../lib/types";

export type VoiceLink = NonNullable<VoiceTake["link"]>;

interface Props {
  project: Project;
  visible: boolean;
  settings: Settings;
  hasGroqKey: boolean;
  onShow: () => void;
  onPatchTakes: (fn: (t: VoiceTake[]) => VoiceTake[]) => void;
  onToTimed: (doc: TimedDoc, words: number) => void;
  onInsertText: (paragraphs: string[]) => void;
  onOpenSettings: () => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
}

type Target = { mode: "new"; at: number } | { mode: "replace"; id: string };
interface RecState {
  phase: "countdown" | "starting" | "recording" | "saving" | "ready";
  target: Target;
  link: VoiceLink | null;
  count?: number;
}
type Play = { mode: "all" } | { mode: "take"; id: string };
type View = "wave" | "text";

/** Akıştaki parça genişliği: saniye başına piksel (çok kısa parçalar da tıklanabilir kalır). */
const PX_PER_SEC = 7;
const chipWidth = (sec: number) => Math.max(46, Math.round(sec * PX_PER_SEC));
const VIEW_KEY = "voiceView";

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const modalOpen = () => !!document.querySelector(".modal-back");

/**
 * Soldaki metinde şu an "üzerinde durulan" bölüm: önce seçili metnin bölümü, yoksa görünür alanın üst üçte birindeki
 * bölüm. Kayıt bu bölüme bağlanır.
 */
function currentLeftLink(project: Project): VoiceLink | null {
  const source = project.sources.find((s) => s.id === project.activeSourceId) ?? project.sources[0];
  if (!source?.segments.length) return null;
  const toLink = (id: string | null | undefined) => {
    const seg = id ? source.segments.find((s) => s.id === id) : null;
    return seg ? { sourceId: source.id, segmentId: seg.id, title: seg.title } : null;
  };
  const sel = window.getSelection();
  const anchor = sel && !sel.isCollapsed ? sel.anchorNode : null;
  const fromSel = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLElement>("[data-segid]");
  if (fromSel) return toLink(fromSel.dataset.segid);
  const secs = Array.from(document.querySelectorAll<HTMLElement>("[data-segid]"));
  if (!secs.length) return null;
  const scroller = secs[0].closest(".pane")?.getBoundingClientRect();
  const y = scroller ? scroller.top + scroller.height / 3 : window.innerHeight / 3;
  const hit = secs.find((el) => {
    const r = el.getBoundingClientRect();
    return r.top <= y && r.bottom >= y;
  });
  return toLink((hit ?? secs.find((el) => el.getBoundingClientRect().bottom > (scroller?.top ?? 0)))?.dataset.segid);
}

function scrollToSegment(segmentId: string) {
  const el = document.querySelector<HTMLElement>(`[data-segid="${CSS.escape(segmentId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("seg-flash");
  void el.offsetWidth;
  el.classList.add("seg-flash");
}

// ---------------------------------------------------------------- Mini dalga formu

type WaveProps = { projectId: string; file: string; bars: number; progress: number | null };
// Çalarken yalnız ilerleyen parçanın dalga formu yeniden çizilir.
const Wave = memo(WaveView, (a, b) => a.projectId === b.projectId && a.file === b.file && a.bars === b.bars && a.progress === b.progress);

function WaveView({ projectId, file, bars, progress }: WaveProps) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setErr(false);
    loadTake(projectId, file)
      .then((b) => alive && setPeaks(peaksOf(b, bars)))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [projectId, file, bars]);
  if (err) return <span className="vc-err" title="Kayıt dosyası okunamadı">⚠</span>;
  if (!peaks) return null;
  const n = peaks.length;
  return (
    <svg className="vc-wave" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from(peaks, (p, i) => {
        const h = Math.max(6, p * 90);
        return <rect key={i} x={i + 0.2} y={50 - h / 2} width={0.6} height={h} className={progress !== null && i / n < progress ? "on" : ""} />;
      })}
    </svg>
  );
}

function Meter({ level }: { level: number }) {
  const db = level > 0 ? 20 * Math.log10(level) : -60;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className={"vr-meter" + (level > 0.97 ? " clip" : "")} title={level > 0.97 ? "Ses çok yüksek (bozulma olabilir)" : `${Math.round(db)} dB`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- Panel

export function VoicePane({ project, visible, settings, hasGroqKey, onShow, onPatchTakes, onToTimed, onInsertText, onOpenSettings, onToast }: Props) {
  const takes = useMemo(() => project.takes ?? [], [project.takes]);
  const takesRef = useRef(takes);
  takesRef.current = takes;
  const projectRef = useRef(project);
  projectRef.current = project;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const { items: timeline, total } = useMemo(() => buildTimeline(takes, settings.voiceGapMs), [takes, settings.voiceGapMs]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const paragraphs = useMemo(() => groupTakes(timeline), [timeline]);

  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === "text" ? "text" : "wave"));
  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<RecState | null>(null);
  const recRef = useRef(rec);
  recRef.current = rec;
  const recording = useRef<Recording | null>(null);
  const [play, setPlay] = useState<Play | null>(null);
  const [pos, setPos] = useState(0); // çizelgedeki konum (durunca da korunur)
  const player = useRef(new VoicePlayer());
  const [, setFrame] = useState(0);
  const [stt, setStt] = useState<{ busy: Set<string>; errors: Record<string, string> }>({ busy: new Set(), errors: {} });
  const sttChain = useRef<Promise<void>>(Promise.resolve());
  /** Son çeviri sonuçları (dosya → metin): proje durumu henüz yeniden çizilmeden okunabilsin diye. */
  const fresh = useRef(new Map<string, NonNullable<VoiceTake["stt"]>>());
  const [undo, setUndo] = useState<{ take: VoiceTake; index: number } | null>(null);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: number | null; link: VoiceLink | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const alive = useRef(true);
  const flowRef = useRef<HTMLDivElement>(null);

  useEffect(() => localStorage.setItem(VIEW_KEY, view), [view]);

  /** Silinen parçanın dosyasını diskten kaldırır. */
  const dropFile = useCallback((file: string) => {
    const pid = projectRef.current.id;
    forgetTakes(pid, file);
    api.deleteVoiceTake(pid, file).catch(() => {});
  }, []);

  // ---- Yaşam döngüsü: açılışta artık dosyaları temizle, kapanırken kaydı/çalmayı durdur
  useEffect(() => {
    alive.current = true;
    const pid = projectRef.current.id;
    api.pruneVoiceTakes(pid, (projectRef.current.takes ?? []).map((t) => t.file)).catch(() => {});
    const p = player.current;
    return () => {
      alive.current = false;
      recording.current?.cancel();
      recording.current = null;
      p.stop();
      // Geri alınmamış silme: dosya şimdi silinir.
      const u = undoRef.current;
      if (u) api.deleteVoiceTake(pid, u.take.file).catch(() => {});
      forgetTakes(pid);
    };
  }, []);

  // ---- Kayıt ve çalma sırasında ekranı tazele (~30 fps)
  const animating = rec?.phase === "recording" || !!play;
  useEffect(() => {
    if (!animating) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      if (now - last >= 33) {
        last = now;
        const p = player.current.position();
        if (p !== null) setPos(p);
        setFrame((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animating]);

  useEffect(() => {
    if (!sel) return;
    flowRef.current?.querySelector(`[data-take="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // Geri alma süresi dolunca dosya silinir.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => {
      dropFile(undo.take.file);
      setUndo(null);
    }, 8_000);
    return () => clearTimeout(t);
  }, [undo, dropFile]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // ---------------------------------------------------------------- Çalma

  const stopPlay = useCallback(() => {
    player.current.stop();
    setPlay(null);
  }, []);

  const playAll = useCallback(
    (from: number) => {
      const tl = timelineRef.current;
      if (!tl.length) return;
      const start = from >= (tl[tl.length - 1]?.end ?? 0) - 0.05 ? 0 : from;
      setPos(start);
      setPlay({ mode: "all" });
      player.current
        .play(projectRef.current.id, tl.map((i) => ({ file: i.take.file, start: i.start })), start, () => alive.current && setPlay(null))
        .catch((e) => {
          if (!alive.current) return;
          setPlay(null);
          onToast(`Çalınamadı: ${e}`, "error");
        });
    },
    [onToast],
  );

  const playTake = useCallback(
    (id: string, offset = 0) => {
      const it = timelineRef.current.find((i) => i.take.id === id);
      if (!it) return;
      const from = it.start + Math.min(Math.max(0, offset), Math.max(0, it.end - it.start - 0.05));
      setSel(id);
      setPos(from);
      setPlay({ mode: "take", id });
      player.current
        .play(projectRef.current.id, [{ file: it.take.file, start: it.start }], from, () => alive.current && setPlay(null), it.end)
        .catch((e) => {
          if (!alive.current) return;
          setPlay(null);
          onToast(`Çalınamadı: ${e}`, "error");
        });
    },
    [onToast],
  );

  const togglePlayAll = () => {
    if (play?.mode === "all") return stopPlay();
    playAll(play ? player.current.position() ?? pos : pos);
  };

  const toggleTake = (id: string) => {
    if (play?.mode === "take" && play.id === id) stopPlay();
    else playTake(id);
  };

  // ---------------------------------------------------------------- Yazıya çevirme

  const transcribe = useCallback(
    (ids: string[]): Promise<void> => {
      for (const id of ids) {
        setStt((s) => ({ busy: new Set(s.busy).add(id), errors: { ...s.errors, [id]: "" } }));
        sttChain.current = sttChain.current.then(async () => {
          const take = takesRef.current.find((t) => t.id === id);
          if (!take || !alive.current) {
            setStt((s) => ({ ...s, busy: new Set([...s.busy].filter((x) => x !== id)) }));
            return;
          }
          let error = "";
          try {
            const lang = settingsRef.current.voiceLanguage || settingsRef.current.sttLanguage;
            const r = await api.transcribeVoiceTake(projectRef.current.id, take.file, lang);
            const words = r.words.map((w) => ({ w: w.word.trim(), s: w.start, e: w.end })).filter((w) => w.w);
            const result = { lang: r.language || "?", text: r.text.trim(), words };
            fresh.current.set(take.file, result);
            onPatchTakes((ts) => ts.map((t) => (t.id === id && t.file === take.file ? { ...t, stt: result } : t)));
            if (!words.length) error = "Konuşma bulunamadı";
          } catch (e) {
            error = String(e);
          }
          if (!alive.current) return;
          setStt((s) => ({ busy: new Set([...s.busy].filter((x) => x !== id)), errors: { ...s.errors, [id]: error } }));
        });
      }
      return sttChain.current;
    },
    [onPatchTakes],
  );

  const needGroq = () => {
    if (hasGroqKey) return false;
    onToast("Yazıya çevirmek için Ayarlar'dan Groq API anahtarını girin", "error");
    onOpenSettings();
    return true;
  };

  const transcribeMissing = async () => {
    if (needGroq()) return;
    const ids = takes.filter((t) => !t.stt && !stt.busy.has(t.id)).map((t) => t.id);
    if (!ids.length) return onToast("Tüm parçalar zaten yazıya çevrilmiş");
    await transcribe(ids);
    if (alive.current) onToast(`${ids.length} parça yazıya çevrildi`);
  };

  const toTimed = async () => {
    if (!takes.length) return;
    const missing = takes.filter((t) => !t.stt).map((t) => t.id);
    if (missing.length) {
      if (needGroq()) return;
      onToast(`${missing.length} parça önce yazıya çevriliyor…`);
      await transcribe(missing.filter((id) => !stt.busy.has(id)));
      await sttChain.current;
      if (!alive.current) return;
    }
    const list = takesRef.current.map((t) => (t.stt ? t : { ...t, stt: fresh.current.get(t.file) ?? null }));
    const doc = takesToTimed(list, settingsRef.current.voiceGapMs, `Ses kayıtları (${list.length} parça)`);
    const words = doc.items.filter((i) => i.k === "w").length;
    if (!words) return onToast("Kayıtlarda konuşma bulunamadı", "error");
    onToTimed(doc, words);
  };

  const insertText = () => {
    const paras = takesText(takes);
    if (!paras.length) return onToast("Önce parçaları yazıya çevirin", "error");
    onInsertText(paras);
  };

  const copyText = async () => {
    const paras = takesText(takes);
    if (!paras.length) return onToast("Yazıya çevrilmiş parça yok", "error");
    try {
      await writeText(paras.join("\n\n"));
      onToast(`${paras.length} parçanın metni kopyalandı`);
    } catch (e) {
      onToast(`Kopyalanamadı: ${e}`, "error");
    }
  };

  // ---------------------------------------------------------------- Kayıt

  const startRec = useCallback(
    async (target: Target, link: VoiceLink | null) => {
      if (recording.current) return;
      player.current.stop();
      setPlay(null);
      const s = settingsRef.current;
      const count = Math.max(0, Math.round(s.voiceCountdown || 0));
      setRec({ phase: count ? "countdown" : "starting", target, link, count });
      for (let n = count; n > 0; n--) {
        setRec((r) => (r ? { ...r, count: n } : r));
        await new Promise((res) => setTimeout(res, 1000));
        if (recRef.current?.phase !== "countdown" || !alive.current) return;
      }
      setRec((r) => (r ? { ...r, phase: "starting" } : r));
      try {
        const r = await Recording.start({
          deviceId: s.voiceDeviceId,
          noiseSuppression: s.voiceNoiseSuppression,
          echoCancellation: s.voiceEchoCancel,
          autoGainControl: s.voiceAutoGain,
        });
        if (!alive.current || recRef.current?.phase !== "starting") {
          r.cancel();
          return;
        }
        recording.current = r;
        setRec((x) => (x ? { ...x, phase: "recording" } : x));
      } catch (e) {
        if (!alive.current) return;
        setRec(null);
        onToast(String(e instanceof Error ? e.message : e), "error");
      }
    },
    [onToast],
  );

  const newRec = useCallback(
    (link?: VoiceLink | null, at?: number) => {
      onShow();
      void startRec({ mode: "new", at: at ?? takesRef.current.length }, link === undefined ? currentLeftLink(projectRef.current) : link);
    },
    [onShow, startRec],
  );

  const finishRec = useCallback(async () => {
    const r = recording.current;
    const state = recRef.current;
    if (!r || !state || state.phase !== "recording") return;
    recording.current = null;
    setRec({ ...state, phase: "saving" });
    try {
      const out = await r.finish();
      if (out.buffer.duration < 0.4) {
        if (alive.current) {
          setRec({ ...state, phase: "ready" });
          onToast("Kayıt çok kısa; tekrar dene", "error");
        }
        return;
      }
      const pid = projectRef.current.id;
      const { file } = await api.saveVoiceTake(pid, out.bytes, out.ext);
      primeTake(pid, file, out.buffer);
      const duration = out.buffer.duration;
      let id: string;
      if (state.target.mode === "replace") {
        id = state.target.id;
        const rid = id;
        const old = takesRef.current.find((t) => t.id === rid)?.file;
        onPatchTakes((ts) => ts.map((t) => (t.id === rid ? { ...t, file, duration, createdAt: Date.now(), stt: null, link: state.link ?? t.link } : t)));
        if (old && old !== file) dropFile(old); // eski ses artık kullanılmıyor
      } else {
        id = crypto.randomUUID();
        const take: VoiceTake = { id, file, duration, createdAt: Date.now(), ...(state.link ? { link: state.link } : {}) };
        const at = state.target.at;
        onPatchTakes((ts) => {
          const next = [...ts];
          next.splice(Math.min(Math.max(0, at), next.length), 0, take);
          return next;
        });
      }
      if (!alive.current) return;
      setRec(null);
      setSel(id);
      if (r.peak < 0.02) onToast("Kayıt neredeyse sessiz; Ayarlar › Ses kaydı'ndan mikrofonu kontrol et", "error");
      if (settingsRef.current.voiceAutoTranscribe && hasGroqKey) void transcribe([id]);
    } catch (e) {
      if (!alive.current) return;
      setRec({ ...state, phase: "ready" });
      onToast(`Kayıt kaydedilemedi: ${e}`, "error");
    }
  }, [dropFile, hasGroqKey, onPatchTakes, onToast, transcribe]);

  /** Süren kaydı atar (diske hiçbir şey yazılmaz); aynı yer için hemen yeniden kayıt alınabilir. */
  const cancelRec = useCallback(() => {
    const state = recRef.current;
    if (!state) return;
    recording.current?.cancel();
    recording.current = null;
    if (state.phase === "recording" || state.phase === "starting") setRec({ ...state, phase: "ready" });
    else setRec(null);
  }, []);

  const retryRec = useCallback(() => {
    const state = recRef.current;
    if (state?.phase !== "ready") return;
    setRec(null);
    void startRec(state.target, state.link);
  }, [startRec]);

  const togglePause = () => {
    const r = recording.current;
    if (!r) return;
    if (r.paused) r.resume();
    else r.pause();
    setFrame((n) => n + 1);
  };

  useEffect(() => {
    const on = (e: Event) => {
      if (recording.current || recRef.current) return onShow();
      newRec((e as CustomEvent<VoiceLink>).detail);
    };
    window.addEventListener(VOICE_RECORD_EVENT, on);
    return () => window.removeEventListener(VOICE_RECORD_EVENT, on);
  }, [newRec, onShow]);

  // ---------------------------------------------------------------- Parça işlemleri

  const remove = (id: string) => {
    const index = takes.findIndex((t) => t.id === id);
    if (index < 0) return;
    if (play?.mode === "take" && play.id === id) stopPlay();
    const take = takes[index];
    // Önceki silme geri alınmadıysa onun dosyası hemen gider.
    if (undoRef.current) dropFile(undoRef.current.take.file);
    onPatchTakes((ts) => ts.filter((t) => t.id !== id));
    setUndo({ take, index });
    setSel((takes[index + 1] ?? takes[index - 1])?.id ?? null);
  };

  const restore = () => {
    if (!undo) return;
    const { take, index } = undo;
    onPatchTakes((ts) => {
      const next = ts.filter((t) => t.id !== take.id);
      next.splice(Math.min(index, next.length), 0, take);
      return next;
    });
    setSel(take.id);
    setUndo(null);
  };

  const rename = (id: string, label: string) => {
    onPatchTakes((ts) => ts.map((t) => (t.id === id ? { ...t, label: label.trim() || undefined } : t)));
    setRenaming(null);
  };

  const relink = (id: string, link: VoiceLink | null) => onPatchTakes((ts) => ts.map((t) => (t.id === id ? { ...t, link: link ?? undefined } : t)));

  /** Sürükle-bırak: parçayı yeni yerine taşır ve bırakıldığı paragrafın bölümüne bağlar. */
  const dropTake = () => {
    if (!drag || drag.to === null) return setDrag(null);
    const from = takes.findIndex((t) => t.id === drag.id);
    const { id, to, link } = drag;
    setDrag(null);
    if (from < 0) return;
    onPatchTakes((ts) => moveTake(ts, from, to).map((t) => (t.id === id ? { ...t, link: link ?? undefined } : t)));
  };

  // ---------------------------------------------------------------- Dışa aktarma

  const exportAudio = async (only?: VoiceTake) => {
    const list = only ? [only] : takes;
    if (!list.length) return;
    const base = (only ? `${project.title} - ${takeTitle(only, takes.indexOf(only))}` : `${project.title} - ses`).replace(/[\\/:*?"<>|]+/g, " ").trim() || "ses";
    let path: string | null = null;
    try {
      path = await save({
        defaultPath: `${base}.mp3`,
        filters: [
          { name: "MP3", extensions: ["mp3"] },
          { name: "M4A (AAC)", extensions: ["m4a"] },
          { name: "WAV", extensions: ["wav"] },
        ],
      });
    } catch (e) {
      return onToast(`Kaydetme penceresi açılamadı: ${e}`, "error");
    }
    if (!path) return;
    setExporting(true);
    const files = list.map((t) => t.file);
    const gap = settings.voiceGapMs;
    try {
      await api.exportVoiceTakes(project.id, files, gap, path);
      onToast(`Ses dosyası kaydedildi: ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      if (String(e) !== "NO_FFMPEG") {
        onToast(String(e), "error");
      } else {
        const wavPath = /\.wav$/i.test(path) ? path : path.replace(/\.[^.\\/]+$/, "") + ".wav";
        try {
          await api.saveBinaryFile(wavPath, await mergeToWav(project.id, files, gap));
          onToast(/\.wav$/i.test(path) ? "WAV dosyası kaydedildi" : "ffmpeg bulunamadığı için WAV olarak kaydedildi (MP3/M4A için ffmpeg kurun)");
        } catch (e2) {
          onToast(`Ses dosyası kaydedilemedi: ${e2}`, "error");
        }
      }
    } finally {
      if (alive.current) setExporting(false);
    }
  };

  // ---------------------------------------------------------------- Kısayollar

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const r = recRef.current;
      const k = e.key.toLowerCase();
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.ctrlKey && e.shiftKey && k === "m") {
        consume();
        if (r?.phase === "recording") void finishRec();
        else if (r?.phase === "ready") retryRec();
        else if (!r) newRec();
        return;
      }
      if (modalOpen() || isEditable(e.target)) return;
      if (r) {
        if (r.phase === "recording") {
          if (e.key === "Enter") return consume(), void finishRec();
          if (e.key === "Escape") return consume(), cancelRec();
          if (e.key === " ") return consume(), togglePause();
        } else if (r.phase === "ready") {
          if (e.key === "Enter" || (k === "r" && !e.ctrlKey)) return consume(), retryRec();
          if (e.key === "Escape") return consume(), setRec(null);
        } else if (r.phase === "countdown" || r.phase === "starting") {
          if (e.key === "Escape") return consume(), cancelRec();
        }
        return;
      }
      if (!visible || e.ctrlKey || e.altKey || e.metaKey) return;
      const tl = timelineRef.current;
      const idx = tl.findIndex((i) => i.take.id === sel);
      if (k === "r") {
        consume();
        newRec();
      } else if (e.key === " ") {
        consume();
        togglePlayAll();
      } else if (e.key === "Enter" && sel) {
        consume();
        toggleTake(sel);
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        consume();
        remove(sel);
      } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        if (!tl.length) return;
        consume();
        const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
        const n = fwd ? (idx < 0 ? 0 : Math.min(tl.length - 1, idx + 1)) : idx < 0 ? tl.length - 1 : Math.max(0, idx - 1);
        setSel(tl[n].take.id);
      } else if (e.key === "F2" && sel) {
        consume();
        setRenaming(sel);
      } else if (e.key === "Escape") {
        if (play) stopPlay();
        else setSel(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---------------------------------------------------------------- Görünüm

  const livePos = player.current.position() ?? pos;
  const cur = play ? locate(timeline, livePos) : null;
  const playingId = play?.mode === "take" ? play.id : play && cur ? timeline[cur.index]?.take.id : null;
  const doneCount = takes.filter((t) => t.stt).length;
  const busyCount = stt.busy.size;
  const r = recording.current;
  const source = project.sources.find((s) => s.id === project.activeSourceId) ?? project.sources[0];
  const selItem = timeline.find((i) => i.take.id === sel) ?? null;
  const replacingId = rec?.target.mode === "replace" ? rec.target.id : null;
  const insertAt = rec?.target.mode === "new" ? rec.target.at : -1;

  const progressOf = (it: TimelineItem) => (playingId === it.take.id ? Math.min(1, Math.max(0, (livePos - it.start) / Math.max(0.01, it.end - it.start))) : null);

  /** Kaydı süren parçanın akıştaki yer tutucusu: süreyle büyür. */
  const liveChip = (
    <span key="__live" className={"vc live " + (rec?.phase ?? "")} style={{ width: chipWidth(r?.elapsed() ?? 0) }} title="Kayıt alınıyor">
      <span className="vr-dot" />
      <span className="vc-dur">{rec?.phase === "recording" ? fmtDur(r?.elapsed() ?? 0) : rec?.phase === "countdown" ? rec.count : "…"}</span>
    </span>
  );

  const dragProps = (it: TimelineItem, link: VoiceLink | null) => ({
    draggable: renaming !== it.take.id,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", it.take.id);
      setDrag({ id: it.take.id, to: null, link: it.take.link ?? null });
    },
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      const rc = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const to = e.clientX < rc.left + rc.width / 2 ? it.index : it.index + 1;
      if (drag.to !== to || drag.link?.segmentId !== link?.segmentId) setDrag({ ...drag, to, link });
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dropTake();
    },
    onDragEnd: () => setDrag(null),
  });

  const dropClass = (i: number) => (drag?.to === i ? " drop-before" : drag?.to === i + 1 ? " drop-after" : "");

  /** Dalga görünümünde parça: genişliği süresiyle orantılı. */
  const waveChip = (it: TimelineItem, link: VoiceLink | null) => {
    const t = it.take;
    const w = chipWidth(t.duration);
    return (
      <button
        key={t.id}
        data-take={t.id}
        className={"vc" + (sel === t.id ? " sel" : "") + (playingId === t.id ? " playing" : "") + (replacingId === t.id ? " replacing" : "") + dropClass(it.index)}
        style={{ width: w }}
        onClick={() => setSel(t.id)}
        onDoubleClick={() => toggleTake(t.id)}
        title={`${takeTitle(t, it.index)} · ${fmtDur(t.duration)}${t.stt?.text ? `\n${t.stt.text.slice(0, 160)}` : ""}\nÇift tık: çal · Sürükle: taşı`}
        {...dragProps(it, link)}
      >
        <Wave projectId={project.id} file={t.file} bars={Math.max(8, Math.round(w / 4))} progress={progressOf(it)} />
        <span className="vc-dur">{fmtDur(t.duration)}</span>
        {stt.busy.has(t.id) && <span className="vc-busy" title="Yazıya çevriliyor" />}
      </button>
    );
  };

  /** Metin görünümünde parça: yazıya çevrildiyse cümle olarak akar, değilse küçük dalga. */
  const textSpan = (it: TimelineItem, link: VoiceLink | null) => {
    const t = it.take;
    if (!t.stt?.words.length) return waveChip(it, link);
    const rel = playingId === t.id ? livePos - it.start : -1;
    return (
      <span
        key={t.id}
        data-take={t.id}
        className={"vs" + (sel === t.id ? " sel" : "") + (playingId === t.id ? " playing" : "") + (replacingId === t.id ? " replacing" : "") + dropClass(it.index)}
        onClick={() => setSel(t.id)}
        title="Çift tık: kelimeden çal · Sürükle: taşı"
        {...dragProps(it, link)}
      >
        {t.stt.words.map((w, wi) => {
          const next = t.stt!.words[wi + 1];
          const on = rel >= w.s && rel < (next ? next.s : w.e + 0.3);
          return (
            <span key={wi} className={on ? "on" : undefined} onDoubleClick={(e) => (e.stopPropagation(), playTake(t.id, w.s))}>
              {w.w}{" "}
            </span>
          );
        })}
      </span>
    );
  };

  /**
   * Süren kaydın akıştaki yeri: paragraf içinde bir parçanın önü, paragraf sonu (aynı bölümse) ya da en sonda yeni
   * bir paragraf. Paragraf sınırına düşen kayıt, bölümü aynıysa önceki paragrafın sonuna eklenir.
   */
  let liveSlot: { para: number; before: number | null } | "tail" | null = null;
  if (insertAt >= 0) {
    const recSeg = rec?.link?.segmentId ?? null;
    const inner = paragraphs.findIndex((p) => insertAt > p.items[0].index && insertAt <= p.items[p.items.length - 1].index);
    if (inner >= 0) liveSlot = { para: inner, before: insertAt };
    else {
      const startPi = paragraphs.findIndex((p) => p.items[0].index === insertAt);
      const prevPi = startPi >= 0 ? startPi - 1 : paragraphs.length - 1;
      if (prevPi >= 0 && paragraphs[prevPi].segmentId === recSeg) liveSlot = { para: prevPi, before: null };
      else if (startPi >= 0) liveSlot = { para: startPi, before: insertAt };
      else liveSlot = "tail";
    }
  }

  const renderPara = (p: (typeof paragraphs)[number], pi: number) => {
    const link = p.items[0].take.link ?? null;
    const lastIdx = p.items[p.items.length - 1].index;
    const dur = p.items.reduce((n, it) => n + it.take.duration, 0);
    const chips: React.ReactNode[] = [];
    const slot = liveSlot !== "tail" && liveSlot?.para === pi ? liveSlot : null;
    for (const it of p.items) {
      if (slot?.before === it.index) chips.push(liveChip);
      chips.push(view === "text" ? textSpan(it, link) : waveChip(it, link));
    }
    if (slot && slot.before === null) chips.push(liveChip);
    return (
      <div key={pi} className="vf-para">
        <div className="vf-head">
          {p.title ? (
            <button className="vf-title ellipsis" onClick={() => p.segmentId && scrollToSegment(p.segmentId)} title="Soldaki bölüme git">
              {p.title}
            </button>
          ) : (
            <span className="vf-title none">Bölümsüz</span>
          )}
          <span className="vf-meta">{fmtDur(dur)}</span>
        </div>
        <div className={"vf-flow" + (view === "text" ? " text" : "")}>
          {chips}
          {!rec && (
            <button
              className="vc-add"
              onClick={() => newRec(link, lastIdx + 1)}
              title={p.title ? `“${p.title}” bölümüne yeni parça kaydet` : "Buraya yeni parça kaydet"}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.to !== lastIdx + 1 || drag.link?.segmentId !== link?.segmentId) setDrag({ ...drag, to: lastIdx + 1, link });
              }}
              onDrop={(e) => (e.preventDefault(), dropTake())}
            >
              ＋
            </button>
          )}
        </div>
      </div>
    );
  };

  const tailLive = liveSlot === "tail";

  // ---- Alt şerit: kayıt denetimleri ya da seçili parça
  const selText = selItem?.take.stt?.words.length
    ? selItem.take.stt.words.map((w, wi) => {
        const rel = playingId === selItem.take.id ? livePos - selItem.start : -1;
        const next = selItem.take.stt!.words[wi + 1];
        const on = rel >= w.s && rel < (next ? next.s : w.e + 0.3);
        return (
          <span key={wi} className={on ? "on" : undefined} onClick={() => playTake(selItem.take.id, w.s)}>
            {w.w}{" "}
          </span>
        );
      })
    : selItem?.take.stt?.text;

  const foot = rec ? (
    <div className={"vd-foot rec " + rec.phase}>
      <div className="vd-row">
        <span className="vr-dot" />
        {rec.phase === "recording" ? (
          <b className="vr-time">{fmtDur(r?.elapsed() ?? 0)}</b>
        ) : (
          <b>
            {rec.phase === "countdown"
              ? `Hazır ol… ${rec.count}`
              : rec.phase === "starting"
                ? "Mikrofon açılıyor…"
                : rec.phase === "saving"
                  ? "Kaydediliyor…"
                  : "Kayıt iptal edildi ve silindi"}
          </b>
        )}
        {rec.phase === "recording" && (r?.paused ? <span className="muted vd-paused">Duraklatıldı</span> : <Meter level={r?.level() ?? 0} />)}
        <select
          className="input vd-link"
          value={rec.link?.segmentId ?? ""}
          title="Bu kaydın ait olduğu soldaki bölüm"
          onChange={(e) => {
            const seg = source?.segments.find((s) => s.id === e.target.value);
            setRec((x) => (x ? { ...x, link: seg && source ? { sourceId: source.id, segmentId: seg.id, title: seg.title } : null } : x));
          }}
        >
          <option value="">Bölümsüz</option>
          {rec.link && !source?.segments.some((s) => s.id === rec.link!.segmentId) && <option value={rec.link.segmentId}>{rec.link.title}</option>}
          {source?.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      <div className="vd-row">
        {rec.phase === "recording" && (
          <>
            <button className="btn primary" onClick={() => void finishRec()} title="Bitir ve kaydet">■ Bitir <kbd>Enter</kbd></button>
            <button className="btn" onClick={togglePause}>{r?.paused ? "▶ Sürdür" : "❚❚ Duraklat"} <kbd>Boşluk</kbd></button>
            <button className="btn danger" onClick={cancelRec} title="Kaydı at; aynı parçayı yeniden kaydedebilirsin">✕ İptal <kbd>Esc</kbd></button>
          </>
        )}
        {rec.phase === "ready" && (
          <>
            <button className="btn primary" onClick={retryRec}>● Yeniden kaydet <kbd>Enter</kbd></button>
            <button className="btn" onClick={() => setRec(null)}>Vazgeç <kbd>Esc</kbd></button>
          </>
        )}
        {(rec.phase === "countdown" || rec.phase === "starting") && (
          <button className="btn" onClick={cancelRec}>Vazgeç <kbd>Esc</kbd></button>
        )}
      </div>
    </div>
  ) : selItem ? (
    <div className="vd-foot">
      <div className="vd-row">
        <button className={"vd-play" + (playingId === selItem.take.id && play?.mode === "take" ? " on" : "")} onClick={() => toggleTake(selItem.take.id)} title="Bu parçayı çal (Enter)">
          {playingId === selItem.take.id && play?.mode === "take" ? "❚❚" : "▶"}
        </button>
        {renaming === selItem.take.id ? (
          <input
            className="input vd-name-input"
            autoFocus
            defaultValue={selItem.take.label ?? ""}
            placeholder={`Parça ${selItem.index + 1}`}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") rename(selItem.take.id, e.currentTarget.value);
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={(e) => rename(selItem.take.id, e.currentTarget.value)}
          />
        ) : (
          <button className="vd-name ellipsis" onClick={() => setRenaming(selItem.take.id)} title="Adlandır (F2)">
            {takeTitle(selItem.take, selItem.index)}
          </button>
        )}
        <span className="muted vd-dur">{fmtDur(selItem.take.duration)}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => void startRec({ mode: "replace", id: selItem.take.id }, selItem.take.link ?? null)} title="Yeniden kaydet (eskisinin yerine geçer)">⟳</button>
        <button className="icon-btn" onClick={() => !needGroq() && void transcribe([selItem.take.id])} disabled={stt.busy.has(selItem.take.id)} title={selItem.take.stt ? "Yeniden yazıya çevir" : "Yazıya çevir"}>✦</button>
        <button
          className="icon-btn"
          onClick={() => {
            const l = currentLeftLink(project);
            if (!l) return onToast("Solda bağlanacak bölüm yok", "error");
            relink(selItem.take.id, l);
          }}
          title="Soldaki görünen bölüme bağla"
        >
          ↳
        </button>
        <button className="icon-btn" onClick={() => void exportAudio(selItem.take)} title="Bu parçayı dosya olarak kaydet">⤓</button>
        <button className="icon-btn danger" onClick={() => remove(selItem.take.id)} title="Sil (Del)">✕</button>
      </div>
      {view === "wave" && (stt.busy.has(selItem.take.id) || selText || stt.errors[selItem.take.id]) && (
        <div className={"vd-text" + (stt.errors[selItem.take.id] && !stt.busy.has(selItem.take.id) ? " err" : "")}>
          {stt.busy.has(selItem.take.id) ? "Yazıya çevriliyor…" : stt.errors[selItem.take.id] ? `Yazıya çevrilemedi: ${stt.errors[selItem.take.id]}` : selText}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="voice-pane" style={{ display: visible ? undefined : "none" }}>
      {(takes.length > 0 || rec) && (
        <div className="vp-bar">
          <button className="vp-rec" onClick={() => newRec()} disabled={!!rec} title="Yeni parça kaydet (R · her yerden Ctrl+Shift+M)">
            <span className="vr-dot" />
            Kaydet
          </button>
          <button className={"vp-play" + (play?.mode === "all" ? " on" : "")} onClick={togglePlayAll} disabled={!takes.length} title="Tümünü art arda çal (Boşluk)">
            {play?.mode === "all" ? "❚❚" : "▶"}
          </button>
          <div
            className="vp-track"
            onClick={(e) => {
              const rc = e.currentTarget.getBoundingClientRect();
              const t = ((e.clientX - rc.left) / rc.width) * total;
              const at = locate(timeline, t);
              if (at) setSel(timeline[at.index].take.id);
              if (play) playAll(t);
              else setPos(t);
            }}
            title="Tıklanan yerden çal"
          >
            <div className="vp-fill" style={{ width: `${(Math.min(livePos, total) / Math.max(total, 0.01)) * 100}%` }} />
            {timeline.slice(1).map((it) => (
              <span key={it.take.id} className="vp-tick" style={{ left: `${(it.start / Math.max(total, 0.01)) * 100}%` }} />
            ))}
          </div>
          <span className="vp-time">
            {fmtDur(livePos)} / {fmtDur(total)}
          </span>
          <div className="vp-view" role="radiogroup" aria-label="Görünüm">
            <button className={view === "wave" ? "on" : ""} onClick={() => setView("wave")} title="Ses dalgaları (genişlik = süre)">Dalga</button>
            <button className={view === "text" ? "on" : ""} onClick={() => setView("text")} title="Yazıya çevrilmiş metin">Metin</button>
          </div>
          <div className="vp-more" onMouseDown={(e) => e.stopPropagation()}>
            <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} title="Diğer işlemler" aria-label="Diğer işlemler">⋯</button>
            {menuOpen && (
              <div className="menu right" onClick={() => setMenuOpen(false)}>
                <button onClick={transcribeMissing} disabled={busyCount > 0 || doneCount === takes.length}>
                  Yazıya çevir <span className="muted">{doneCount}/{takes.length}</span>
                </button>
                <button onClick={toTimed} disabled={busyCount > 0 || !takes.length}>Zamanlı metne aktar</button>
                <button onClick={insertText} disabled={!doneCount}>Metni senaryoya ekle</button>
                <button onClick={copyText} disabled={!doneCount}>Metni kopyala</button>
                <div className="menu-sep" />
                <button onClick={() => void exportAudio()} disabled={exporting || !takes.length}>
                  {exporting ? "Birleştiriliyor…" : "Tek ses dosyası olarak kaydet"} <span className="muted">MP3 · WAV</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="vp-flow" ref={flowRef} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {!takes.length && !rec ? (
          <div className="vp-empty">
            <button className="vp-big-rec" onClick={() => newRec()} title="Kaydı başlat">
              <span className="vr-dot" />
            </button>
            <p>Soldaki metni kendi cümlelerinle, parça parça seslendir.</p>
            <p className="muted small">
              <kbd>R</kbd> kaydet · <kbd>Enter</kbd> bitir · <kbd>Esc</kbd> iptal · <kbd>Boşluk</kbd> dinle
            </p>
            {!hasGroqKey && (
              <p className="muted small">
                Yazıya çevirmek için <button className="link-btn" onClick={onOpenSettings}>Groq anahtarı</button> gerekir.
              </p>
            )}
          </div>
        ) : (
          <>
            {paragraphs.map(renderPara)}
            {tailLive && (
              <div className="vf-para">
                <div className="vf-head">
                  <span className={"vf-title" + (rec?.link ? "" : " none")}>{rec?.link?.title ?? "Bölümsüz"}</span>
                </div>
                <div className="vf-flow">{liveChip}</div>
              </div>
            )}
          </>
        )}
      </div>

      {undo && !rec && (
        <div className="vd-undo">
          <span>“{takeTitle(undo.take, undo.index)}” silindi</span>
          <button className="link-btn" onClick={restore}>Geri al</button>
        </div>
      )}
      {foot}
    </div>
  );
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { VOICE_RECORD_EVENT, buildTimeline, fmtDur, locate, moveTake, takesText, takesToTimed, takeTitle, type TimelineItem } from "../lib/voice";
import { loadTake, mergeToWav, peaksOf, primeTake, Recording, VoicePlayer } from "../lib/voiceAudio";
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

// ---------------------------------------------------------------- Dalga formu

type WaveProps = { projectId: string; file: string; progress: number | null; onSeek: (frac: number) => void };
// Çalarken yalnız ilerleyen parçanın dalga formu yeniden çizilir (onSeek ref'lerden okuyan kararlı bir işleve gider).
const Wave = memo(WaveView, (a, b) => a.projectId === b.projectId && a.file === b.file && a.progress === b.progress);

function WaveView({ projectId, file, progress, onSeek }: WaveProps) {
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setErr(false);
    loadTake(projectId, file)
      .then((b) => alive && setPeaks(peaksOf(b, 160)))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [projectId, file]);
  if (err) return <div className="vt-wave err">⚠ Kayıt dosyası okunamadı</div>;
  const n = peaks?.length ?? 0;
  return (
    <div
      className="vt-wave"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      title="Tıklanan yerden çal"
    >
      {peaks && (
        <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
          {Array.from(peaks, (p, i) => {
            const h = Math.max(3, p * 92);
            const played = progress !== null && i / n < progress;
            return <rect key={i} x={i + 0.15} y={50 - h / 2} width={0.7} height={h} className={played ? "on" : ""} />;
          })}
        </svg>
      )}
      {progress !== null && <div className="vt-head" style={{ left: `${progress * 100}%` }} />}
    </div>
  );
}

// ---------------------------------------------------------------- Seviye ölçer

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
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const alive = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);

  // ---- Yaşam döngüsü: açılışta artık dosyaları temizle, kapanırken kaydı/çalmayı durdur
  useEffect(() => {
    alive.current = true;
    const keep = (projectRef.current.takes ?? []).map((t) => t.file);
    api.pruneVoiceTakes(projectRef.current.id, keep).catch(() => {});
    const p = player.current;
    return () => {
      alive.current = false;
      recording.current?.cancel();
      recording.current = null;
      p.stop();
    };
  }, []);

  // ---- Kayıt ve çalma sırasında ekranı tazele
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

  // Seçili parçayı görünür tut
  useEffect(() => {
    if (!sel) return;
    listRef.current?.querySelector(`[data-take="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(t);
  }, [undo]);

  // ---------------------------------------------------------------- Çalma

  const stopPlay = useCallback(() => {
    player.current.stop();
    setPlay(null);
  }, []);

  /** Tüm parçaları `from` anından itibaren çalar. */
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

  /** Tek parçayı (isteğe bağlı olarak içinden bir andan) çalar. */
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

  const togglePlayAll = useCallback(() => {
    if (play?.mode === "all") {
      stopPlay();
      return;
    }
    playAll(play ? player.current.position() ?? pos : pos);
  }, [play, pos, playAll, stopPlay]);

  const toggleTake = (id: string) => {
    if (play?.mode === "take" && play.id === id) stopPlay();
    else playTake(id);
  };

  const jump = (dir: -1 | 1) => {
    const tl = timelineRef.current;
    if (!tl.length) return;
    const cur = player.current.position() ?? pos;
    const at = locate(tl, cur)?.index ?? tl.length - 1;
    // Geri: parçanın başından 1 sn'den fazla geçildiyse aynı parçanın başına
    const target = dir < 0 ? (cur - (tl[at]?.start ?? 0) > 1 ? at : Math.max(0, at - 1)) : Math.min(tl.length - 1, at + 1);
    const t = tl[target].start;
    setSel(tl[target].take.id);
    if (play) playAll(t);
    else setPos(t);
  };

  // ---------------------------------------------------------------- Yazıya çevirme

  const sttLang = () => settingsRef.current.voiceLanguage || settingsRef.current.sttLanguage;

  /** Parçaları sırayla yazıya çevirir; tamamlanınca çözülen söz döner. */
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
            const r = await api.transcribeVoiceTake(projectRef.current.id, take.file, sttLang());
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

  /** Eksik parçaları çevirip hepsini tek zamanlı metne aktarır. */
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
    if (!paras.length) return onToast(takes.length ? "Önce parçaları yazıya çevirin" : "Henüz kayıt yok", "error");
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
        onPatchTakes((ts) => ts.map((t) => (t.id === rid ? { ...t, file, duration, createdAt: Date.now(), stt: null, link: state.link ?? t.link } : t)));
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
  }, [hasGroqKey, onPatchTakes, onToast, transcribe]);

  /** Süren kaydı atar; aynı yer için hemen yeniden kayıt alınabilir. */
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

  // Soldaki bölüm düğmesinden gelen kayıt isteği
  useEffect(() => {
    const on = (e: Event) => {
      const link = (e as CustomEvent<VoiceLink>).detail;
      if (recording.current || recRef.current) {
        onShow();
        return;
      }
      newRec(link);
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
    onPatchTakes((ts) => ts.filter((t) => t.id !== id));
    setUndo({ take, index });
    const next = takes[index + 1] ?? takes[index - 1];
    setSel(next?.id ?? null);
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

  const relink = (id: string, link: VoiceLink | null) => {
    onPatchTakes((ts) => ts.map((t) => (t.id === id ? { ...t, link: link ?? undefined } : t)));
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from + 1 === to) return;
    onPatchTakes((ts) => moveTake(ts, from, to));
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
        // ffmpeg yoksa WAV'ı burada üret
        const wavPath = /\.wav$/i.test(path) ? path : path.replace(/\.[^.\\/]+$/, "") + ".wav";
        try {
          const wav = await mergeToWav(project.id, files, gap);
          await api.saveBinaryFile(wavPath, wav);
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
      const hot = e.ctrlKey && e.shiftKey && k === "m";
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (hot) {
        consume();
        if (r?.phase === "recording") void finishRec();
        else if (r?.phase === "ready") retryRec();
        else if (!r) newRec();
        return;
      }
      if (modalOpen()) return;
      if (r) {
        if (isEditable(e.target)) return;
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
      if (!visible || isEditable(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
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
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!tl.length) return;
        consume();
        const n = e.key === "ArrowDown" ? (idx < 0 ? 0 : Math.min(tl.length - 1, idx + 1)) : idx < 0 ? tl.length - 1 : Math.max(0, idx - 1);
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
  const playingId = play?.mode === "take" ? play.id : play ? (cur ? timeline[cur.index]?.take.id : null) : null;
  const doneCount = takes.filter((t) => t.stt).length;
  const busyCount = stt.busy.size;
  const r = recording.current;
  const recTargetIndex = rec ? (rec.target.mode === "new" ? rec.target.at : takes.findIndex((t) => t.id === (rec.target as { id: string }).id)) : -1;
  const source = project.sources.find((s) => s.id === project.activeSourceId) ?? project.sources[0];

  const recCard = rec && (
    <div className={"vr-card " + rec.phase}>
      <div className="vr-top">
        <span className="vr-dot" />
        <b>
          {rec.phase === "countdown"
            ? `Hazır ol… ${rec.count}`
            : rec.phase === "starting"
              ? "Mikrofon açılıyor…"
              : rec.phase === "saving"
                ? "Kaydediliyor…"
                : rec.phase === "ready"
                  ? "Kayıt iptal edildi"
                  : r?.paused
                    ? "Duraklatıldı"
                    : "Kayıt alınıyor"}
        </b>
        <span className="muted">
          {rec.target.mode === "replace" ? `${takeTitle(takes[recTargetIndex] ?? ({} as VoiceTake), recTargetIndex)} yeniden kaydediliyor` : `Parça ${recTargetIndex + 1}`}
        </span>
        <span className="spacer" />
        {rec.phase === "recording" && <span className="vr-time">{fmtDur(r?.elapsed() ?? 0)}</span>}
      </div>
      {rec.phase === "recording" && <Meter level={r?.level() ?? 0} />}
      <div className="vr-link">
        <span className="muted">Bölüm:</span>
        <select
          className="input"
          value={rec.link?.segmentId ?? ""}
          onChange={(e) => {
            const seg = source?.segments.find((s) => s.id === e.target.value);
            const link = seg && source ? { sourceId: source.id, segmentId: seg.id, title: seg.title } : null;
            setRec((x) => (x ? { ...x, link } : x));
          }}
        >
          <option value="">(bağlantı yok)</option>
          {rec.link && !source?.segments.some((s) => s.id === rec.link!.segmentId) && <option value={rec.link.segmentId}>{rec.link.title}</option>}
          {source?.segments.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      <div className="vr-actions">
        {rec.phase === "recording" && (
          <>
            <button className="btn primary" onClick={() => void finishRec()} title="Bitir ve kaydet (Enter · Ctrl+Shift+M)">
              ■ Bitir <kbd>Enter</kbd>
            </button>
            <button className="btn" onClick={togglePause} title="Duraklat / sürdür (Boşluk)">
              {r?.paused ? "▶ Sürdür" : "❚❚ Duraklat"} <kbd>Boşluk</kbd>
            </button>
            <button className="btn danger" onClick={cancelRec} title="Bu kaydı at; aynı parçayı yeniden kaydedebilirsin (Esc)">
              ✕ İptal <kbd>Esc</kbd>
            </button>
          </>
        )}
        {rec.phase === "ready" && (
          <>
            <button className="btn primary" onClick={retryRec} title="Aynı parçayı yeniden kaydet (Enter · R)">
              ● Yeniden kaydet <kbd>Enter</kbd>
            </button>
            <button className="btn" onClick={() => setRec(null)} title="Kapat (Esc)">
              Vazgeç <kbd>Esc</kbd>
            </button>
          </>
        )}
        {(rec.phase === "countdown" || rec.phase === "starting") && (
          <button className="btn" onClick={cancelRec}>
            Vazgeç <kbd>Esc</kbd>
          </button>
        )}
      </div>
    </div>
  );

  const takeRow = (it: TimelineItem) => {
    const t = it.take;
    const i = it.index;
    const isSel = sel === t.id;
    const isPlaying = playingId === t.id;
    const prog = isPlaying ? Math.min(1, Math.max(0, (livePos - it.start) / Math.max(0.01, it.end - it.start))) : null;
    const rel = isPlaying ? livePos - it.start : -1;
    const busy = stt.busy.has(t.id);
    const err = stt.errors[t.id];
    const beingReplaced = rec?.target.mode === "replace" && rec.target.id === t.id;
    return (
      <div key={t.id}>
        {drag && drag.to === i && <div className="vt-drop" />}
        {((rec?.target.mode === "new" && rec.target.at === i) || beingReplaced) && recCard}
        <div
          data-take={t.id}
          className={"vt" + (isSel ? " sel" : "") + (isPlaying ? " playing" : "") + (beingReplaced ? " replacing" : "")}
          onClick={() => setSel(t.id)}
          onDoubleClick={(e) => !(e.target as HTMLElement).closest("button,input,.vt-wave,.vt-text") && toggleTake(t.id)}
          draggable={renaming !== t.id}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", t.id);
            setDrag({ from: i, to: null });
          }}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            const rct = e.currentTarget.getBoundingClientRect();
            const to = e.clientY < rct.top + rct.height / 2 ? i : i + 1;
            if (drag.to !== to) setDrag({ ...drag, to });
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (drag?.to != null) reorder(drag.from, drag.to);
            setDrag(null);
          }}
          onDragEnd={() => setDrag(null)}
        >
          <div className="vt-row">
            <span className="vt-grip" title="Sürükleyerek sırala">⋮⋮</span>
            <button className={"vt-play" + (isPlaying ? " on" : "")} onClick={() => toggleTake(t.id)} title={isPlaying ? "Durdur" : "Bu parçayı çal (Enter)"} aria-label="Çal">
              {isPlaying ? "❚❚" : "▶"}
            </button>
            <span className="vt-num">{i + 1}</span>
            {renaming === t.id ? (
              <input
                className="input vt-name-input"
                autoFocus
                defaultValue={t.label ?? ""}
                placeholder={`Parça ${i + 1}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") rename(t.id, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={(e) => rename(t.id, e.currentTarget.value)}
              />
            ) : (
              <span className="vt-name ellipsis" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(t.id))} title="Çift tıklayarak adlandır (F2)">
                {takeTitle(t, i)}
              </span>
            )}
            {t.link && (
              <button className="vt-link ellipsis" onClick={(e) => (e.stopPropagation(), scrollToSegment(t.link!.segmentId))} title={`Soldaki bölüme git: ${t.link.title}`}>
                ↳ {t.link.title}
              </button>
            )}
            <span className="spacer" />
            <span className="vt-dur">{fmtDur(t.duration)}</span>
            <button className="icon-btn" onClick={(e) => (e.stopPropagation(), void startRec({ mode: "replace", id: t.id }, t.link ?? null))} disabled={!!rec} title="Bu parçayı yeniden kaydet (eskisinin yerine geçer)">
              ⟳
            </button>
            <div className="vt-menu-wrap">
              <button className="icon-btn" onClick={(e) => (e.stopPropagation(), setMenu(menu === t.id ? null : t.id))} title="Diğer işlemler" aria-label="Diğer işlemler">
                ⋯
              </button>
              {menu === t.id && (
                <div className="menu right" onMouseLeave={() => setMenu(null)} onClick={() => setMenu(null)}>
                  <button onClick={() => newRec(t.link ?? undefined, i + 1)} disabled={!!rec}>
                    ＋ Sonrasına yeni kayıt
                  </button>
                  <button onClick={() => setRenaming(t.id)}>
                    ✎ Adlandır <span className="muted">F2</span>
                  </button>
                  <button
                    onClick={() => {
                      const l = currentLeftLink(project);
                      if (!l) return onToast("Solda bağlanacak bölüm yok", "error");
                      relink(t.id, l);
                      onToast(`“${l.title}” bölümüne bağlandı`);
                    }}
                  >
                    ↳ Soldaki görünen bölüme bağla
                  </button>
                  {t.link && <button onClick={() => relink(t.id, null)}>Bölüm bağlantısını kaldır</button>}
                  <button onClick={() => !needGroq() && void transcribe([t.id])} disabled={busy}>
                    ✦ {t.stt ? "Yeniden yazıya çevir" : "Yazıya çevir"}
                  </button>
                  <button onClick={() => void exportAudio(t)}>⤓ Bu parçayı dışa aktar</button>
                  <div className="menu-sep" />
                  <button className="danger" onClick={() => remove(t.id)}>
                    Sil <span className="muted">Del</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <Wave projectId={project.id} file={t.file} progress={prog} onSeek={(f) => playTake(t.id, f * t.duration)} />
          {busy ? (
            <div className="vt-text muted">✦ Yazıya çevriliyor…</div>
          ) : t.stt ? (
            <div className="vt-text">
              {t.stt.words.length
                ? t.stt.words.map((w, wi) => {
                    const next = t.stt!.words[wi + 1];
                    const on = rel >= w.s && rel < (next ? next.s : w.e + 0.3);
                    return (
                      <span key={wi} className={"vt-w" + (on ? " on" : "")} onClick={(e) => (e.stopPropagation(), playTake(t.id, w.s))}>
                        {w.w}{" "}
                      </span>
                    );
                  })
                : <span className="muted">{t.stt.text || "Konuşma bulunamadı"}</span>}
            </div>
          ) : err ? (
            <div className="vt-text err">
              Yazıya çevrilemedi: {err}{" "}
              <button className="btn small" onClick={() => !needGroq() && void transcribe([t.id])}>
                Tekrar dene
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="voice-pane" style={{ display: visible ? undefined : "none" }}>
      <div className="vp-tools">
        <button className="btn primary vp-rec" onClick={() => newRec()} disabled={!!rec} title="Yeni parça kaydet (R · her yerden Ctrl+Shift+M). Soldaki seçili/görünen bölüme bağlanır.">
          <span className="vr-dot" /> Kayıt <kbd>R</kbd>
        </button>
        <span className="spacer" />
        {takes.length > 0 && (
          <>
            <button className="btn small" onClick={transcribeMissing} disabled={busyCount > 0 || doneCount === takes.length} title="Yazıya çevrilmemiş parçaları Groq Whisper ile çevir">
              ✦ Yazıya çevir {doneCount < takes.length && <span className="muted">({takes.length - doneCount})</span>}
            </button>
            <button className="btn small" onClick={toTimed} disabled={busyCount > 0} title="Tüm parçaları tek bir kelime kelime zamanlı metne aktar (birleşik kayda göre zamanlanır)">
              ⏱ Zamanlı metne aktar
            </button>
            <button className="btn small" onClick={insertText} disabled={!doneCount} title="Parçaların metnini senaryonun sonuna paragraflar halinde ekle">
              ＋ Senaryoya ekle
            </button>
            <button className="btn small" onClick={copyText} disabled={!doneCount} title="Parçaların metnini panoya kopyala">
              ⧉ Metni kopyala
            </button>
            <button className="btn small" onClick={() => void exportAudio()} disabled={exporting} title="Tüm parçaları tek ses dosyasında birleştir (MP3 / M4A / WAV)">
              {exporting ? "⏳ Birleştiriliyor…" : "⤓ Tek dosya"}
            </button>
          </>
        )}
      </div>

      {takes.length > 0 && (
        <div className="vp-player">
          <button className="icon-btn" onClick={() => jump(-1)} title="Önceki parça" aria-label="Önceki parça">⏮</button>
          <button className={"vp-play" + (play?.mode === "all" ? " on" : "")} onClick={togglePlayAll} title="Tümünü art arda çal / duraklat (Boşluk)" aria-label="Tümünü çal">
            {play?.mode === "all" ? "❚❚" : "▶"}
          </button>
          <button className="icon-btn" onClick={() => jump(1)} title="Sonraki parça" aria-label="Sonraki parça">⏭</button>
          <span className="vp-time">{fmtDur(livePos)}</span>
          <div
            className="vp-bar"
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
            {timeline.map((it) => (
              <div
                key={it.take.id}
                className={"vp-seg" + (it.take.id === sel ? " sel" : "") + (it.take.id === playingId ? " on" : "")}
                style={{ left: `${(it.start / Math.max(total, 0.01)) * 100}%`, width: `${((it.end - it.start) / Math.max(total, 0.01)) * 100}%` }}
                title={`${it.index + 1}. ${takeTitle(it.take, it.index)} · ${fmtDur(it.end - it.start)}`}
              />
            ))}
            <div className="vp-head" style={{ left: `${(Math.min(livePos, total) / Math.max(total, 0.01)) * 100}%` }} />
          </div>
          <span className="vp-time">{fmtDur(total)}</span>
        </div>
      )}

      {undo && (
        <div className="banner busy">
          <span>“{takeTitle(undo.take, undo.index)}” silindi</span>
          <button className="btn small" onClick={restore}>Geri al</button>
        </div>
      )}

      <div className="vp-list" ref={listRef} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        {!takes.length && !rec && (
          <div className="vp-empty">
            <button className="vp-big-rec" onClick={() => newRec()} title="Kaydı başlat (R · Ctrl+Shift+M)">
              <span className="vr-dot" />
            </button>
            <p className="start-title">Senaryoyu kendi sesinle, parça parça kaydet</p>
            <p className="muted">
              Soldaki bölümü okuyup kendi cümlelerinle anlat. Her kayıt ayrı bir parça olur; beğenmediğini iptal edip hemen yeniden alırsın. Sonra hepsini art arda dinleyebilir,
              tek ses dosyası olarak alabilir ya da kelime kelime zamanlı metne çevirebilirsin.
            </p>
            <div className="vp-keys">
              <span><kbd>R</kbd> / <kbd>Ctrl+Shift+M</kbd> kayıt başlat</span>
              <span><kbd>Enter</kbd> bitir</span>
              <span><kbd>Esc</kbd> iptal (yeniden kaydet)</span>
              <span><kbd>Boşluk</kbd> duraklat · tümünü çal</span>
              <span><kbd>↑</kbd><kbd>↓</kbd> parça seç · <kbd>Del</kbd> sil</span>
            </div>
            {!hasGroqKey && (
              <p className="muted small">
                Yazıya çevirmek için <button className="link-btn" onClick={onOpenSettings}>Groq API anahtarı</button> gerekir; kayıt ve dinleme anahtarsız çalışır.
              </p>
            )}
          </div>
        )}
        {timeline.map(takeRow)}
        {drag && drag.to === takes.length && <div className="vt-drop" />}
        {rec && (rec.target.mode === "new" ? rec.target.at >= takes.length : !takes.some((t) => t.id === (rec.target as { id: string }).id)) && recCard}
        {takes.length > 0 && (
          <div
            className="vp-tail"
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              if (drag.to !== takes.length) setDrag({ ...drag, to: takes.length });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag?.to != null) reorder(drag.from, drag.to);
              setDrag(null);
            }}
          >
            {!rec && (
              <button className="btn small ghost" onClick={() => newRec()}>
                ● Sona yeni parça kaydet
              </button>
            )}
            <span className="muted">
              {takes.length} parça · {fmtDur(total)}
              {busyCount > 0 ? ` · ${busyCount} parça yazıya çevriliyor` : doneCount ? ` · ${doneCount}/${takes.length} yazıya çevrildi` : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

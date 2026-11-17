import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, onSttProgress } from "../lib/api";
import { matchCombo, prettyCombo } from "../lib/keys";
import { voiceKeys } from "../lib/settingsDefaults";
import { VOICE_RECORD_EVENT, alignPunctuation, buildTimeline, fmtDur, groupTakes, locate, moveTake, packBatches, splitWords, takeParagraphs, takesText, takesToTimed, takeTitle, type TimelineItem } from "../lib/voice";
import { forgetTakes, loadTake, mergeToWav, peaksOf, primeTake, Recording, renderForStt, VoicePlayer } from "../lib/voiceAudio";
import { sttMissingMessage, sttOptions, whisperOnGpu } from "../lib/stt";
import { keysClaimed } from "../lib/keyScope";
import type { Project, Settings, TimedDoc, VoiceTake } from "../lib/types";

export type VoiceLink = NonNullable<VoiceTake["link"]>;

interface Props {
  project: Project;
  visible: boolean;
  settings: Settings;
  /** Ses → yazı motoru hazır mı (Groq anahtarı ya da yerel model). */
  sttOk: boolean;
  onShow: () => void;
  onPatchTakes: (fn: (t: VoiceTake[]) => VoiceTake[]) => void;
  onToTimed: (doc: TimedDoc, words: number) => void;
  onInsertText: (paragraphs: ReturnType<typeof takeParagraphs>) => void;
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

/** Toplu çeviride parçalar arasına konan sessizlik (sn): kelimeler parçalara karışmasın. */
const STT_GAP = 1;
/** Tek istekte gönderilen en uzun ses (sn); 16 kHz WAV'da ~19 MB, Groq'un 25 MB sınırının altı. */
const STT_BATCH_SEC = 600;

/** Yazıya çevrilmemiş parçanın genişliği: saniye başına piksel. */
const PX_PER_SEC = 7;
const chipWidth = (sec: number) => Math.max(46, Math.round(sec * PX_PER_SEC));

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const modalOpen = () => !!document.querySelector(".modal-back");
/** Güncel kayıt evresi (await sonrası TS daraltmasından kaçmak için işlev). */
const phaseOf = (r: { current: RecState | null }) => r.current?.phase;

function scrollToSegment(segmentId: string) {
  const el = document.querySelector<HTMLElement>(`[data-segid="${CSS.escape(segmentId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("seg-flash");
  void el.offsetWidth;
  el.classList.add("seg-flash");
}

// ---------------------------------------------------------------- Dalga formu (genişliğe göre çubuk sayısı)

type WaveProps = { projectId: string; file: string; progress: number | null };
const Wave = memo(WaveView, (a, b) => a.projectId === b.projectId && a.file === b.file && a.progress === b.progress);

function WaveView({ projectId, file, progress }: WaveProps) {
  const box = useRef<HTMLDivElement>(null);
  const [bars, setBars] = useState(0);
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setErr(false);
    loadTake(projectId, file)
      .then((b) => alive && setBuf(b))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [projectId, file]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setBars(Math.max(8, Math.round(el.clientWidth / 3.5)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const peaks = useMemo(() => (buf && bars ? peaksOf(buf, bars) : null), [buf, bars]);
  const n = peaks?.length ?? 0;
  return (
    <div className="vc-wave" ref={box}>
      {err ? (
        <span className="vc-err" title="Kayıt dosyası okunamadı">⚠</span>
      ) : (
        peaks && (
          <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
            {Array.from(peaks, (p, i) => {
              const h = Math.max(8, p * 92);
              return <rect key={i} x={i + 0.2} y={50 - h / 2} width={0.6} height={h} className={progress !== null && i / n < progress ? "on" : ""} />;
            })}
          </svg>
        )
      )}
      {progress !== null && <span className="vc-head" style={{ left: `${progress * 100}%` }} />}
    </div>
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

// ---------------------------------------------------------------- İkonlar

/**
 * Yüzen düğme simgeleri: hepsi 24'lük ızgarada (12,12) merkezine göre çizilir ve aynı boyutta gösterilir.
 * Oynat üçgeni görsel olarak ortalı dursun diye ağırlık merkezi hafif sağdadır.
 */
const icon = (children: React.ReactNode, size = 16) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="fb-ico">
    {children}
  </svg>
);
const I = {
  rec: <span className="fb-dot" />,
  play: icon(<path d="M8.9 5.6v12.8L19.4 12z" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />),
  pause: icon(
    <>
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
    </>,
  ),
  stop: icon(<rect x="6" y="6" width="12" height="12" rx="2.2" fill="currentColor" />),
  close: icon(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />),
  redo: icon(
    <path
      d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
  ),
  start: icon(
    <>
      <rect x="5.2" y="6" width="2.4" height="12" rx="1" fill="currentColor" />
      <path d="M18.2 6.4v11.2L9.7 12z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </>,
  ),
};

// ---------------------------------------------------------------- Panel

export function VoicePane({ project, visible, settings, sttOk, onShow, onPatchTakes, onToTimed, onInsertText, onOpenSettings, onToast }: Props) {
  const takes = useMemo(() => project.takes ?? [], [project.takes]);
  const takesRef = useRef(takes);
  takesRef.current = takes;
  const projectRef = useRef(project);
  projectRef.current = project;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const keys = voiceKeys(settings);
  const kb = (a: keyof typeof keys) => prettyCombo(keys[a]);

  const { items: timeline, total } = useMemo(() => buildTimeline(takes, settings.voiceGapMs), [takes, settings.voiceGapMs]);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const paragraphs = useMemo(() => groupTakes(timeline), [timeline]);

  const [sel, setSel] = useState<string | null>(null);
  const [rec, setRec] = useState<RecState | null>(null);
  const recRef = useRef(rec);
  recRef.current = rec;
  const recording = useRef<Recording | null>(null);
  const [playing, setPlaying] = useState(false);
  /** Oynatma imleci (çizelgede sn): seçim ve tıklamalar burayı taşır, Boşluk buradan çalar. */
  const [pos, setPos] = useState(0);
  const posRef = useRef(pos);
  posRef.current = pos;
  const player = useRef(new VoicePlayer());
  const [, setFrame] = useState(0);
  const [stt, setStt] = useState<{ busy: Set<string>; errors: Record<string, string> }>({ busy: new Set(), errors: {} });
  /** Yazıya çevrilmeyi bekleyen parçalar ve onları toplu gönderen döngü. */
  const sttQueue = useRef<string[]>([]);
  const sttRun = useRef<Promise<void> | null>(null);
  /**
   * Kuyruğa doğrudan verilen parçalar (yeni ya da yeniden kaydedilmiş). Proje durumu henüz yeniden çizilmediği için
   * takesRef bunları (ya da yeni dosya adını) bilmiyor olabilir; çeviri bu kopyalarla yapılır.
   */
  const sttSnap = useRef(new Map<string, VoiceTake>());
  /** Süren çevirinin ilerlemesi (sn ve parça olarak); yerel Whisper yüzdesi gelen grubu içinde ilerletir. */
  const sttTotals = useRef({ doneSec: 0, totalSec: 0, doneTakes: 0, totalTakes: 0 });
  const [sttProg, setSttProg] = useState<{ pct: number; done: number; total: number } | null>(null);
  /** Son çeviri sonuçları (dosya → metin): proje durumu henüz yeniden çizilmeden okunabilsin diye. */
  const fresh = useRef(new Map<string, NonNullable<VoiceTake["stt"]>>());
  const [undo, setUndo] = useState<{ take: VoiceTake; index: number } | null>(null);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: number | null; link: VoiceLink | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const alive = useRef(true);
  const flowRef = useRef<HTMLDivElement>(null);

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
      const u = undoRef.current;
      if (u) api.deleteVoiceTake(pid, u.take.file).catch(() => {});
      forgetTakes(pid);
    };
  }, []);

  // ---- Kayıt ve çalma sırasında ekranı tazele (~30 fps)
  const animating = rec?.phase === "recording" || playing;
  const liveLevels = useRef<number[]>([]);
  useEffect(() => {
    if (!animating) return;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      if (now - last >= 33) {
        last = now;
        const p = player.current.position();
        if (p !== null) setPos(p);
        // Süren kaydın canlı dalgası: her 1/4 saniyenin tepe seviyesi
        const r = recording.current;
        if (r && !r.paused) {
          const lv = liveLevels.current;
          const slot = Math.floor(r.elapsed() * 4);
          const v = r.level();
          while (lv.length <= slot) lv.push(0);
          lv[slot] = Math.max(lv[slot], v);
        }
        setFrame((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animating]);

  // Çalarken seçim, çalan parçayı izler.
  const cur = locate(timeline, pos);
  const curId = cur ? timeline[cur.index]?.take.id ?? null : null;
  useEffect(() => {
    if (playing && curId) setSel(curId);
  }, [playing, curId]);

  useEffect(() => {
    if (!sel) return;
    flowRef.current?.querySelector(`[data-take="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [sel]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => {
      dropFile(undo.take.file);
      setUndo(null);
    }, 8_000);
    return () => clearTimeout(t);
  }, [undo, dropFile]);

  useEffect(() => {
    if (!menuOpen && !ctx) return;
    const close = () => {
      setMenuOpen(false);
      setCtx(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menuOpen, ctx]);

  // ---------------------------------------------------------------- Çalma (tek mod: imleçten sona kadar)

  const playFrom = useCallback(
    (from: number) => {
      const tl = timelineRef.current;
      if (!tl.length) return;
      const end = tl[tl.length - 1].end;
      const start = from >= end - 0.05 ? 0 : Math.max(0, from);
      setPos(start);
      setPlaying(true);
      player.current
        .play(projectRef.current.id, tl.map((i) => ({ file: i.take.file, start: i.start })), start, () => {
          if (!alive.current) return;
          setPlaying(false);
          setPos(end);
        })
        .catch((e) => {
          if (!alive.current) return;
          setPlaying(false);
          onToast(`Çalınamadı: ${e}`, "error");
        });
    },
    [onToast],
  );

  const pause = useCallback(() => {
    const p = player.current.position();
    player.current.stop();
    setPlaying(false);
    if (p !== null) setPos(p);
  }, []);

  const togglePlay = () => (playing ? pause() : playFrom(posRef.current));

  /** İmleci bir ana taşır; çalıyorsa oradan devam eder. */
  const seek = (t: number) => {
    if (playing) playFrom(t);
    else setPos(Math.max(0, t));
  };

  /** Parçayı seçer ve imleci başına koyar. */
  const selectTake = (id: string, offset = 0) => {
    const it = timelineRef.current.find((i) => i.take.id === id);
    if (!it) return;
    setSel(id);
    seek(it.start + offset);
  };

  const toStart = () => {
    setSel(null);
    seek(0);
  };

  // ---------------------------------------------------------------- Yazıya çevirme

  /** Bir grup parçayı tek ses olarak gönderir, gelen kelimeleri sürelerine göre parçalara dağıtır. */
  const runBatch = useCallback(
    async (batch: VoiceTake[]) => {
      const st = settingsRef.current;
      const lang = st.voiceLanguage || st.sttLanguage;
      const errors: Record<string, string> = {};
      let failure = "";
      let silent = 0;
      const tot = sttTotals.current;
      const batchSec = batch.reduce((n, t) => n + Math.max(0, t.duration), 0);
      const show = (inBatch: number) =>
        setSttProg({
          pct: Math.min(100, ((tot.doneSec + (batchSec * inBatch) / 100) / Math.max(0.01, tot.totalSec)) * 100),
          done: tot.doneTakes,
          total: tot.totalTakes,
        });
      show(0);
      const job = crypto.randomUUID();
      const unlisten = st.sttEngine === "local" ? onSttProgress(job, (p) => alive.current && sttTotals.current === tot && show(p)) : null;
      try {
        const { wav, spans } = await renderForStt(projectRef.current.id, batch.map((t) => t.file), STT_GAP);
        const r = await api.transcribeAudio(wav, { ...sttOptions(st, lang), job });
        const fixed = alignPunctuation(r.text, r.words.map((w) => w.word.trim()));
        const parts = splitWords(r.words.map((w, i) => ({ ...w, word: fixed[i] })), spans);
        const results = new Map<string, NonNullable<VoiceTake["stt"]>>();
        batch.forEach((take, i) => {
          const words = parts[i];
          const result = { lang: r.language || "?", text: words.map((w) => w.w).join(" "), words };
          fresh.current.set(take.file, result);
          results.set(take.file, result);
          if (!words.length) {
            errors[take.id] = "Konuşma bulunamadı";
            silent++;
          }
        });
        onPatchTakes((ts) => ts.map((t) => (results.has(t.file) ? { ...t, stt: results.get(t.file)! } : t)));
      } catch (e) {
        failure = String(e);
        for (const t of batch) errors[t.id] = failure;
      }
      void unlisten?.then((f) => f());
      tot.doneSec += batchSec;
      tot.doneTakes += batch.length;
      if (!alive.current) return;
      show(0);
      const ids = new Set(batch.map((t) => t.id));
      // Bu sırada yeniden kuyruğa giren parça (ör. yeniden kaydedilen) meşgul kalır.
      setStt((s) => ({ busy: new Set([...s.busy].filter((x) => !ids.has(x) || sttQueue.current.includes(x))), errors: { ...s.errors, ...errors } }));
      if (failure) onToast(`Yazıya çevrilemedi${batch.length > 1 ? ` (${batch.length} parça)` : ""}: ${failure}`, "error");
      else if (silent) onToast(silent === 1 && batch.length === 1 ? "Kayıtta konuşma bulunamadı" : `${silent} parçada konuşma bulunamadı`, "error");
    },
    [onPatchTakes, onToast],
  );

  /**
   * Parçaları yazıya çevirme kuyruğuna ekler. Kuyruktakiler tek tek değil, çizelge sırasıyla birleştirilip
   * en fazla STT_BATCH_SEC'lik gruplar halinde gönderilir. Dönen söz kuyruk boşalınca çözülür.
   */
  const transcribe = useCallback(
    (items: (string | VoiceTake)[]): Promise<void> => {
      for (const it of items) if (typeof it !== "string") sttSnap.current.set(it.id, it);
      const ids = items.map((it) => (typeof it === "string" ? it : it.id));
      const add = ids.filter((id) => !sttQueue.current.includes(id));
      if (add.length) {
        sttQueue.current.push(...add);
        const tot = sttTotals.current;
        tot.totalTakes += add.length;
        const durOf = (id: string) => sttSnap.current.get(id)?.duration ?? takesRef.current.find((t) => t.id === id)?.duration ?? 0;
        tot.totalSec += add.reduce((n, id) => n + Math.max(0, durOf(id)), 0);
        setStt((s) => {
          const busy = new Set(s.busy);
          const errors = { ...s.errors };
          for (const id of add) {
            busy.add(id);
            errors[id] = "";
          }
          return { busy, errors };
        });
      }
      if (!sttRun.current && sttQueue.current.length) {
        sttRun.current = (async () => {
          while (sttQueue.current.length && alive.current) {
            const queued = sttQueue.current.splice(0);
            // Güncel liste sırası; listede henüz görünmeyen (yeni) ya da daha yeni kopyası olan parçalar kopyadan alınır.
            const order = new Map(takesRef.current.map((t, i) => [t.id, i]));
            const list = queued
              .map((id) => {
                const cur = takesRef.current.find((t) => t.id === id);
                const snap = sttSnap.current.get(id);
                sttSnap.current.delete(id);
                return snap && (!cur || snap.createdAt >= cur.createdAt) ? snap : cur;
              })
              .filter((t): t is VoiceTake => !!t)
              .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
            const gone = queued.filter((id) => !list.some((t) => t.id === id));
            sttTotals.current.totalTakes -= gone.length;
            if (gone.length) setStt((s) => ({ ...s, busy: new Set([...s.busy].filter((x) => !gone.includes(x))) }));
            for (const batch of packBatches(list, STT_BATCH_SEC, STT_GAP)) {
              if (!alive.current) break;
              await runBatch(batch);
            }
          }
          sttRun.current = null;
          sttTotals.current = { doneSec: 0, totalSec: 0, doneTakes: 0, totalTakes: 0 };
          if (alive.current) setSttProg(null);
        })();
      }
      return sttRun.current ?? Promise.resolve();
    },
    [runBatch],
  );

  const needStt = () => {
    if (sttOk) return false;
    onToast(sttMissingMessage(settingsRef.current), "error");
    onOpenSettings();
    return true;
  };

  const transcribeMissing = async () => {
    if (needStt()) return;
    const ids = takes.filter((t) => !t.stt && !stt.busy.has(t.id)).map((t) => t.id);
    if (!ids.length) return onToast("Tüm parçalar zaten yazıya çevrilmiş");
    await transcribe(ids);
    if (alive.current) onToast(`${ids.length} parça yazıya çevrildi`);
  };

  const toTimed = async () => {
    if (!takes.length) return;
    const missing = takes.filter((t) => !t.stt && !t.note).map((t) => t.id);
    if (missing.length) {
      if (needStt()) return;
      onToast(`${missing.length} parça önce yazıya çevriliyor…`);
      // Hâlihazırda gönderilenler yeniden eklenmez; dönen söz onların bitmesini de bekler.
      await transcribe(missing.filter((id) => !stt.busy.has(id)));
      if (!alive.current) return;
    }
    const list = takesRef.current.map((t) => (t.stt ? t : { ...t, stt: fresh.current.get(t.file) ?? null }));
    const doc = takesToTimed(list, settingsRef.current.voiceGapMs, `Ses kayıtları (${list.length} parça)`);
    const words = doc.items.filter((i) => i.k === "w").length;
    if (!doc.items.length) return onToast("Kayıtlarda konuşma bulunamadı", "error");
    onToTimed(doc, words);
  };

  const insertText = () => {
    const paras = takeParagraphs(takes);
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
      if (recording.current || recRef.current?.phase === "starting" || recRef.current?.phase === "countdown" || recRef.current?.phase === "saving") return;
      player.current.stop();
      setPlaying(false);
      const s = settingsRef.current;
      const count = Math.max(0, Math.round(s.voiceCountdown || 0));
      setRec({ phase: count ? "countdown" : "starting", target, link, count });
      for (let n = count; n > 0; n--) {
        setRec((r) => (r ? { ...r, count: n } : r));
        await new Promise((res) => setTimeout(res, 1000));
        if (phaseOf(recRef) !== "countdown" || !alive.current) return;
      }
      setRec((r) => (r ? { ...r, phase: "starting" } : r));
      try {
        const r = await Recording.start({
          deviceId: s.voiceDeviceId,
          noiseSuppression: s.voiceNoiseSuppression,
          echoCancellation: s.voiceEchoCancel,
          autoGainControl: s.voiceAutoGain,
        });
        if (!alive.current || phaseOf(recRef) !== "starting") {
          r.cancel();
          return;
        }
        liveLevels.current = [];
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

  /** Yeni parça: varsayılan olarak sona eklenir ve hiçbir bölüme bağlanmaz (genel kayıt). */
  const newRec = useCallback(
    (link: VoiceLink | null = null, at?: number) => {
      onShow();
      void startRec({ mode: "new", at: at ?? takesRef.current.length }, link);
    },
    [onShow, startRec],
  );

  const rerecord = (id: string) => {
    const t = takesRef.current.find((x) => x.id === id);
    if (t) void startRec({ mode: "replace", id }, t.link ?? null);
  };

  const finishRec = useCallback(async () => {
    const r = recording.current;
    const state = recRef.current;
    if (!r || !state || state.phase !== "recording") return;
    const saving: RecState = { ...state, phase: "saving" };
    recRef.current = saving;
    setRec(saving);
    try {
      if (!r.paused) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        if (!alive.current || recording.current !== r) return;
        r.level();
      }
      recording.current = null;
      const out = await r.finish();
      if (!alive.current) return;
      if (out.buffer.duration < 0.4) {
        if (alive.current) {
          setRec({ ...state, phase: "ready" });
          onToast("Kayıt çok kısa; tekrar dene", "error");
        }
        return;
      }
      const pid = projectRef.current.id;
      const { file } = await api.saveVoiceTake(pid, out.bytes, out.ext);
      if (!alive.current) {
        void api.deleteVoiceTake(pid, file).catch(() => {});
        return;
      }
      primeTake(pid, file, out.buffer);
      const duration = out.buffer.duration;
      let id: string;
      let saved: VoiceTake | null = null;
      if (state.target.mode === "replace") {
        id = state.target.id;
        const rid = id;
        const prev = takesRef.current.find((t) => t.id === rid);
        const old = prev?.file;
        const createdAt = Date.now();
        if (prev) saved = { ...prev, file, duration, createdAt, stt: null };
        onPatchTakes((ts) => ts.map((t) => (t.id === rid ? { ...t, file, duration, createdAt, stt: null } : t)));
        if (old && old !== file) dropFile(old);
      } else {
        id = crypto.randomUUID();
        const take: VoiceTake = { id, file, duration, createdAt: Date.now(), ...(state.link ? { link: state.link } : {}) };
        saved = take;
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
      // Yeni parça proje listesine henüz yansımamış olabilir: kuyruğa parçanın kendisi verilir.
      if (settingsRef.current.voiceAutoTranscribe && sttOk && saved) void transcribe([saved]);
    } catch (e) {
      if (!alive.current) return;
      setRec({ ...state, phase: "ready" });
      onToast(`Kayıt kaydedilemedi: ${e}`, "error");
    }
  }, [dropFile, sttOk, onPatchTakes, onToast, transcribe]);

  /** Süren kaydı atar (diske hiçbir şey yazılmaz); aynı yer için hemen yeniden kayıt alınabilir. */
  const cancelRec = useCallback(() => {
    const state = recRef.current;
    if (!state || state.phase === "saving") return;
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

  // Soldaki bölümün mikrofon düğmesi: o bölüme bağlı kayıt.
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
    if (playing) pause();
    const take = takes[index];
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

  const unlink = (id?: string) =>
    onPatchTakes((ts) => ts.map((t) => (!id || t.id === id ? (({ link: _l, ...rest }) => rest)(t) : t)));

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
    const list = (only ? [only] : takes).filter((t) => !t.note);
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

  // ---------------------------------------------------------------- Kısayollar (Ayarlar › Ses kaydı'ndan değiştirilebilir)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("[data-keycapture]")) return;
      // Tam ekran video / kare görüntüleyici açıkken hiçbir kısayol bu panele gelmez.
      const claim = keysClaimed();
      if (claim === "exclusive") return;
      const r = recRef.current;
      const k = voiceKeys(settingsRef.current);
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (matchCombo(e, k.toggle)) {
        consume();
        if (r?.phase === "recording") void finishRec();
        else if (r?.phase === "ready") retryRec();
        else if (!r) newRec();
        return;
      }
      if (modalOpen() || isEditable(e.target)) return;
      if (r) {
        if (r.phase === "recording") {
          if (matchCombo(e, k.finish)) return consume(), void finishRec();
          if (matchCombo(e, k.cancel)) return consume(), cancelRec();
          if (matchCombo(e, k.pause)) return consume(), togglePause();
        } else if (r.phase === "ready") {
          if (matchCombo(e, k.finish) || matchCombo(e, k.record)) return consume(), retryRec();
          if (matchCombo(e, k.cancel)) return consume(), setRec(null);
        } else if (r.phase === "countdown" || r.phase === "starting") {
          if (matchCombo(e, k.cancel)) return consume(), cancelRec();
        }
        return;
      }
      // Video odaktayken / fare üzerindeyken Boşluk ve oklar videonundur.
      if (!visible || claim === "local") return;
      const tl = timelineRef.current;
      const idx = tl.findIndex((i) => i.take.id === sel);
      if (matchCombo(e, k.record)) {
        consume();
        newRec();
      } else if (matchCombo(e, k.play)) {
        consume();
        togglePlay();
      } else if (sel && matchCombo(e, k.rerecord)) {
        consume();
        rerecord(sel);
      } else if (sel && matchCombo(e, k.remove)) {
        consume();
        remove(sel);
      } else if (e.key === "Enter" && !e.ctrlKey && !e.altKey && sel) {
        consume();
        const it = tl[idx];
        if (it) playFrom(it.start);
      } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key) && !e.ctrlKey && !e.altKey) {
        if (!tl.length) return;
        consume();
        const fwd = e.key === "ArrowDown" || e.key === "ArrowRight";
        const n = fwd ? (idx < 0 ? 0 : Math.min(tl.length - 1, idx + 1)) : idx < 0 ? tl.length - 1 : Math.max(0, idx - 1);
        selectTake(tl[n].take.id);
      } else if (e.key === "Home") {
        consume();
        toStart();
      } else if (e.key === "Escape") {
        if (playing) pause();
        else setSel(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---------------------------------------------------------------- Görünüm

  const livePos = player.current.position() ?? pos;
  const liveCur = locate(timeline, livePos);
  const playingId = playing && liveCur ? timeline[liveCur.index]?.take.id ?? null : null;
  const doneCount = takes.filter((t) => t.stt).length;
  const hasText = takes.some((t) => t.note || t.stt?.text.trim());
  const busyCount = stt.busy.size;
  const r = recording.current;
  const replacingId = rec?.target.mode === "replace" ? rec.target.id : null;
  const insertAt = rec?.target.mode === "new" ? rec.target.at : -1;
  const hasLinks = takes.some((t) => t.link);
  // Durunca imlecin olduğu parça (çizgisi gösterilir)
  const cursorId = !playing && liveCur && livePos > 0 ? timeline[liveCur.index]?.take.id ?? null : null;

  const progressOf = (it: TimelineItem) => {
    if (playingId === it.take.id || cursorId === it.take.id) return Math.min(1, Math.max(0, (livePos - it.start) / Math.max(0.01, it.end - it.start)));
    return null;
  };

  const liveBars = liveLevels.current;
  const liveMax = Math.max(0.05, ...liveBars);
  const liveChip = (
    <div key="__live" className={"vc live " + (rec?.phase ?? "")} style={{ width: chipWidth(r?.elapsed() ?? 0) }} title={rec?.phase === "saving" ? "Kayıt kaydediliyor" : "Kayıt alınıyor"}>
      <div className="vc-wave">
        {rec?.phase === "recording" || rec?.phase === "saving" ? (
          liveBars.length > 0 && (
            <svg viewBox={`0 0 ${liveBars.length} 100`} preserveAspectRatio="none" aria-hidden="true">
              {liveBars.map((v, i) => {
                const h = Math.max(8, Math.min(1, v / liveMax) * 92);
                return <rect key={i} x={i + 0.2} y={50 - h / 2} width={0.6} height={h} />;
              })}
            </svg>
          )
        ) : (
          <span className="vc-livenote">{rec?.phase === "countdown" ? rec.count : rec?.phase === "ready" ? "✕" : "…"}</span>
        )}
      </div>
    </div>
  );

  const dragProps = (it: TimelineItem, link: VoiceLink | null) => ({
    draggable: true,
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

  /** Parça: üstte dalga, yazıya çevrildiyse altında metin. Çevrilen parça metni kadar uzar. */
  const chip = (it: TimelineItem, link: VoiceLink | null) => {
    const t = it.take;
    const words = t.stt?.words ?? [];
    const rel = playingId === t.id || cursorId === t.id ? livePos - it.start : -1;
    const busy = stt.busy.has(t.id);
    const cls =
      "vc" +
      (words.length ? " has-text" : "") +
      (sel === t.id ? " sel" : "") +
      (playingId === t.id ? " playing" : "") +
      (replacingId === t.id ? " replacing" : "") +
      (drag?.to === it.index ? " drop-before" : drag?.to === it.index + 1 ? " drop-after" : "");
    return (
      <div
        key={t.id}
        data-take={t.id}
        className={cls}
        style={words.length ? { minWidth: chipWidth(t.duration) } : { width: chipWidth(t.duration) }}
        onClick={(e) => {
          e.stopPropagation();
          selectTake(t.id);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          // Dalga üzerinde: tıklanan andan; metinde kelimeden (kelime kendi işler)
          const wave = (e.target as HTMLElement).closest(".vc-wave");
          if (wave) {
            const rc = wave.getBoundingClientRect();
            playFrom(it.start + ((e.clientX - rc.left) / rc.width) * t.duration);
          } else playFrom(it.start);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSel(t.id);
          setCtx({ id: t.id, x: e.clientX, y: e.clientY });
        }}
        title={`${it.index + 1}. parça · ${fmtDur(t.duration)} — çift tık: çal · sağ tık: işlemler · sürükle: taşı`}
        {...dragProps(it, link)}
      >
        <Wave projectId={project.id} file={t.file} progress={progressOf(it)} />
        {t.note && <div className="vc-text"><strong>Not</strong>{!words.length && ` · ${t.stt?.text.trim() || takeTitle(t, it.index)}`}</div>}
        {words.length > 0 && (
          <div className="vc-text">
            {words.map((w, wi) => {
              const next = words[wi + 1];
              const on = rel >= w.s && rel < (next ? next.s : w.e + 0.3);
              return (
                <span
                  key={wi}
                  className={on ? "on" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSel(t.id);
                    seek(it.start + w.s);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setSel(t.id);
                    playFrom(it.start + w.s);
                  }}
                >
                  {w.w}{" "}
                </span>
              );
            })}
          </div>
        )}
        {busy && <span className="vc-busy" title="Yazıya çevriliyor" />}
        <span className="vc-dur">{fmtDur(t.duration)}</span>
      </div>
    );
  };

  // Süren kaydın akıştaki yeri (paragraf içi, paragraf sonu ya da en sonda yeni paragraf)
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
    const slot = liveSlot !== "tail" && liveSlot?.para === pi ? liveSlot : null;
    const nodes: React.ReactNode[] = [];
    for (const it of p.items) {
      if (slot?.before === it.index) nodes.push(liveChip);
      nodes.push(chip(it, link));
    }
    if (slot && slot.before === null) nodes.push(liveChip);
    return (
      <div key={pi} className="vf-para">
        {p.title && (
          <div className="vf-head">
            <button className="vf-title ellipsis" onClick={() => p.segmentId && scrollToSegment(p.segmentId)} title="Soldaki bölüme git">
              {p.title}
            </button>
          </div>
        )}
        <div className="vf-flow">{nodes}</div>
      </div>
    );
  };

  const ctxTake = ctx ? takes.find((t) => t.id === ctx.id) ?? null : null;
  const ctxIndex = ctxTake ? takes.indexOf(ctxTake) : -1;

  // ---- Yüzen denetimler
  const floating = (
    <div className={"vfloat" + (rec ? " rec " + rec.phase : "")} onMouseDown={(e) => e.stopPropagation()}>
      {!rec && (
        <>
          <button className="fb" onClick={toStart} disabled={!takes.length} title="Başa dön (Home)">
            {I.start}
          </button>
          <button className={"fb play" + (playing ? " on" : "")} onClick={togglePlay} disabled={!takes.length} title={`${playing ? "Duraklat" : "Çal"} (${kb("play")})`}>
            {playing ? I.pause : I.play}
          </button>
          <button className="fb main rec" onClick={() => newRec()} title={`Kaydet (${kb("record")} · her yerden ${kb("toggle")})`}>
            {I.rec}
          </button>
          <button className="fb" onClick={() => sel && rerecord(sel)} disabled={!sel} title={`Seçili parçayı yeniden al (${kb("rerecord")})`}>
            {I.redo}
          </button>
        </>
      )}
      {rec?.phase === "recording" && (
        <>
          <button className="fb" onClick={cancelRec} title={`İptal et ve sil (${kb("cancel")})`}>
            {I.close}
          </button>
          <div className="fb-status">
            <span className={"fb-dot small" + (r?.paused ? " paused" : " live")} />
            <b>{fmtDur(r?.elapsed() ?? 0)}</b>
            {r?.paused ? <span className="muted">Duraklatıldı</span> : <Meter level={r?.level() ?? 0} />}
          </div>
          <button className="fb" onClick={togglePause} title={`${r?.paused ? "Sürdür" : "Duraklat"} (${kb("pause")})`}>
            {r?.paused ? I.play : I.pause}
          </button>
          <button className="fb main stop" onClick={() => void finishRec()} title={`Bitir ve kaydet (${kb("finish")})`}>
            {I.stop}
          </button>
        </>
      )}
      {rec?.phase === "ready" && (
        <>
          <span className="fb-note">Kayıt iptal edildi ve silindi</span>
          <button className="fb" onClick={() => setRec(null)} title={`Kapat (${kb("cancel")})`}>
            {I.close}
          </button>
          <button className="fb main rec" onClick={retryRec} title={`Yeniden al (${kb("finish")} · ${kb("record")})`}>
            {I.redo}
          </button>
        </>
      )}
      {(rec?.phase === "countdown" || rec?.phase === "starting" || rec?.phase === "saving") && (
        <>
          <span className="fb-note">{rec.phase === "countdown" ? <b className="fb-count">{rec.count}</b> : rec.phase === "starting" ? "Mikrofon açılıyor…" : "Kaydediliyor…"}</span>
          {rec.phase !== "saving" && (
            <button className="fb" onClick={cancelRec} title={`Vazgeç (${kb("cancel")})`}>
              {I.close}
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="voice-pane" style={{ display: visible ? undefined : "none" }}>
      {takes.length > 0 && (
        <div className="vp-bar">
          <div
            className="vp-track"
            onClick={(e) => {
              const rc = e.currentTarget.getBoundingClientRect();
              const t = ((e.clientX - rc.left) / rc.width) * total;
              const at = locate(timeline, t);
              if (at) setSel(timeline[at.index].take.id);
              seek(t);
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
          <div className="vp-more" onMouseDown={(e) => e.stopPropagation()}>
            <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} title="Diğer işlemler" aria-label="Diğer işlemler">
              ⋯
            </button>
            {menuOpen && (
              <div className="menu right" onClick={() => setMenuOpen(false)}>
                <button onClick={transcribeMissing} disabled={busyCount > 0 || doneCount === takes.length}>
                  Yazıya çevir <span className="muted">{doneCount}/{takes.length}</span>
                </button>
                <button onClick={toTimed} disabled={busyCount > 0}>Zamanlı metne aktar</button>
                <button onClick={insertText} disabled={!hasText}>Metni senaryoya ekle</button>
                <button onClick={copyText} disabled={!hasText}>Metni kopyala</button>
                <div className="menu-sep" />
                <button onClick={() => void exportAudio()} disabled={exporting || takes.every((t) => t.note)}>
                  {exporting ? "Birleştiriliyor…" : "Tek ses dosyası olarak kaydet"} <span className="muted">MP3 · WAV</span>
                </button>
                {hasLinks && (
                  <>
                    <div className="menu-sep" />
                    <button onClick={() => unlink()}>Bölüm başlıklarını kaldır</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {sttProg && (
        <div className="vp-stt" title="Yazıya çevirme ilerlemesi">
          <span>
            Yazıya çevriliyor{settings.sttEngine === "local" ? ` (yerel Whisper${whisperOnGpu(settings) ? " · ekran kartı" : ""})` : ""} · {sttProg.done}/
            {sttProg.total} parça
            {settings.sttEngine === "local" ? ` · %${Math.floor(sttProg.pct)}` : ""}
          </span>
          <div className="stt-bar">
            <div style={{ width: `${sttProg.pct}%` }} />
          </div>
        </div>
      )}

      <div
        className="vp-flow"
        ref={flowRef}
        onClick={() => setSel(null)}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest(".vc") && toStart()}
        onDragOver={(e) => {
          if (!drag || (e.target as HTMLElement).closest(".vc")) return;
          e.preventDefault();
          if (drag.to !== takes.length) setDrag({ ...drag, to: takes.length, link: takes[takes.length - 1]?.link ?? null });
        }}
        onDrop={(e) => {
          e.preventDefault();
          dropTake();
        }}
      >
        {!takes.length && !rec ? (
          <div className="vp-empty">
            <p>Soldaki metni kendi cümlelerinle, parça parça seslendir.</p>
            <p className="muted small">
              Aşağıdaki kırmızı düğme ya da <kbd>{kb("record")}</kbd> ile başla · <kbd>{kb("finish")}</kbd> bitir · <kbd>{kb("cancel")}</kbd> iptal
            </p>
            {!sttOk && (
              <p className="muted small">
                Yazıya çevirmek için <button className="link-btn" onClick={onOpenSettings}>{settings.sttEngine === "local" ? "yerel Whisper modeli" : "Groq anahtarı"}</button> gerekir.
              </p>
            )}
          </div>
        ) : (
          <>
            {paragraphs.map(renderPara)}
            {liveSlot === "tail" && (
              <div className="vf-para">
                {rec?.link && (
                  <div className="vf-head">
                    <span className="vf-title">{rec.link.title}</span>
                  </div>
                )}
                <div className="vf-flow">{liveChip}</div>
              </div>
            )}
          </>
        )}
      </div>

      {undo && !rec && (
        <div className="vd-undo">
          <span>{undo.index + 1}. parça silindi</span>
          <button className="link-btn" onClick={restore}>
            Geri al
          </button>
        </div>
      )}

      {floating}

      {ctx && ctxTake && (
        <div
          className="menu ctx-menu"
          style={{ left: Math.min(ctx.x, window.innerWidth - 240), top: Math.min(ctx.y, window.innerHeight - 290) }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setCtx(null)}
        >
          <button onClick={() => playFrom(timeline[ctxIndex]?.start ?? 0)}>Buradan çal</button>
          <button onClick={() => rerecord(ctxTake.id)}>
            Yeniden al <span className="muted">{kb("rerecord")}</span>
          </button>
          <button onClick={() => newRec(ctxTake.link ?? null, ctxIndex + 1)}>Sonrasına yeni kayıt</button>
          <button onClick={() => !needStt() && void transcribe([ctxTake.id])} disabled={stt.busy.has(ctxTake.id)}>
            {ctxTake.stt ? "Yeniden yazıya çevir" : "Yazıya çevir"}
          </button>
          <button onClick={() => {
            onPatchTakes((ts) => ts.map((t) => t.id === ctxTake.id ? { ...t, note: !ctxTake.note || undefined } : t));
            if (!ctxTake.note && !ctxTake.stt && sttOk && !stt.busy.has(ctxTake.id)) void transcribe([ctxTake.id]);
          }}>{ctxTake.note ? "Not işaretini kaldır" : "Nota dönüştür"}</button>
          <button onClick={() => void exportAudio(ctxTake)} disabled={ctxTake.note || exporting}>Dosya olarak kaydet</button>
          {ctxTake.link && <button onClick={() => unlink(ctxTake.id)}>Bölüm başlığından ayır</button>}
          <div className="menu-sep" />
          <button className="danger" onClick={() => remove(ctxTake.id)}>
            Sil <span className="muted">{kb("remove")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

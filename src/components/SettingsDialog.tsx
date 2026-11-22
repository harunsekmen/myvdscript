import { StyleReferencesEditor } from "./StyleReferencesEditor";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, onWhisperDownload, type WhisperProgress } from "../lib/api";
import { modelInstalled, refreshWhisper, subscribeWhisper, whisperStatus, WHISPER_MODELS } from "../lib/stt";
import { levelMeter, listMics, openMic } from "../lib/voiceAudio";
import { FONT_OPTIONS, fontCss } from "../lib/fonts";
import { DEFAULT_SETTINGS, DEFAULT_STAGES, DEFAULT_VOICE_KEYS, voiceKeys } from "../lib/settingsDefaults";
import { comboFromEvent, prettyCombo } from "../lib/keys";
import type { Settings, StageDef, StatsSource, SttEngine, VoiceKeyAction } from "../lib/types";

interface Props {
  settings: Settings;
  models: string[];
  hasKey: boolean;
  hasGroqKey: boolean;
  hasYoutubeKey: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onModels: (m: string[]) => void;
  onKeyChanged: (has: boolean) => void;
  onGroqKeyChanged: (has: boolean) => void;
  onYoutubeKeyChanged: (has: boolean) => void;
  onClose: () => void;
}

type Section = "ai" | "speech" | "voice" | "home" | "prompts" | "look";
type Msg = { text: string; err?: boolean } | null;

// ---- İkonlar (tek renk, çizgi) ----
const PATHS: Record<string, string> = {
  ai: "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
  speech: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  voice: "M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0",
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  prompts: "M4 5h16M4 10h10M4 15h16M4 20h7",
  look: "M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-4.3-4.3",
  close: "M6 6l12 12M18 6L6 18",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  reset: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4",
};
function Ico({ n, size = 16 }: { n: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[n]} />
    </svg>
  );
}

const SECTIONS: { id: Section; label: string; hint: string; keywords: string }[] = [
  { id: "ai", label: "Yapay zekâ", hint: "Bağlantı ve modeller", keywords: "api adres anahtar key model sıcaklık temperature parça chunk openai openrouter deepseek ollama sağlayıcı bağlantı" },
  { id: "speech", label: "Ses ve YouTube", hint: "Whisper (Groq / yerel), çerezler", keywords: "groq whisper yerel local model indir ses konuşma dil stt youtube çerez cookie firefox 429" },
  { id: "voice", label: "Ses kaydı", hint: "Mikrofon, dil, parçalar", keywords: "ses kayıt mikrofon kayıt parça dil gürültü yankı kazanç geri sayım boşluk seslendirme voice" },
  { id: "home", label: "Ana sayfa", hint: "Aşamalar, video verisi", keywords: "ana sayfa aşama kontrol listesi izlenme yt-dlp youtube api anahtar pano kart otomatik" },
  { id: "prompts", label: "İstemler", hint: "Yazım stili ve AI talimatları", keywords: "istem prompt talimat sistem açıklama insight stil script dosya örnek txt md" },
  { id: "look", label: "Görünüm", hint: "Yazı tipi ve düzen", keywords: "yazı tipi font boyut satır aralığı genişlik oran renk segment görünüm" },
];

/** OpenAI uyumlu yaygın sağlayıcıların adresleri. */
const PROVIDERS: { name: string; url: string }[] = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { name: "Groq", url: "https://api.groq.com/openai/v1" },
  { name: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "Ollama", url: "http://localhost:11434/v1" },
  { name: "LM Studio", url: "http://localhost:1234/v1" },
];

const sameUrl = (a: string, b: string) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u || "—";
  }
};

function ModelPicker({ value, models, onChange, placeholder }: { value: string; models: string[]; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState<string | null>(null);
  const shown = (q ?? "").toLowerCase();
  const list = models.filter((m) => m.toLowerCase().includes(shown)).slice(0, 200);
  return (
    <div className="model-picker">
      <input
        className="input"
        placeholder={placeholder ?? (models.length ? `${models.length} model içinde ara veya yaz…` : "Model adını yaz…")}
        value={q ?? value}
        spellCheck={false}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => {
          setQ(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => setTimeout(() => (setOpen(false), setQ(null)), 150)}
      />
      {open && list.length > 0 && (
        <div className="menu model-list">
          {list.map((m) => (
            <button key={m} className={m === value ? "on" : ""} onMouseDown={() => (onChange(m), setOpen(false), setQ(null))}>
              <span className="ellipsis">{m}</span>
              {m === value && <Ico n="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Başlıklı kart */
function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="s-card">
      <header className="s-card-head">
        <h4>{title}</h4>
        {hint && <p>{hint}</p>}
      </header>
      <div className="s-card-body">{children}</div>
    </section>
  );
}

/** Sol: etiket + açıklama, sağ: denetim. `wide` ise denetim alta iner. */
function Row({ label, desc, aside, wide, children }: { label: string; desc?: ReactNode; aside?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={"s-row" + (wide ? " wide" : "")}>
      <div className="s-row-text">
        <div className="s-row-label">
          {label}
          {aside}
        </div>
        {desc && <div className="s-row-desc">{desc}</div>}
      </div>
      <div className="s-row-ctl">{children}</div>
    </div>
  );
}

function Status({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <span className={"s-status " + (msg.err ? "err" : "ok")}>{msg.text}</span>;
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="s-seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={value === o.v} className={value === o.v ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const fmtMB = (b: number) => (b >= 1e9 ? `${(b / 1e9).toLocaleString("tr-TR", { maximumFractionDigits: 2 })} GB` : `${Math.round(b / 1e6)} MB`);

/** Yerel Whisper: motor + model indirme, seçme ve silme. */
function LocalWhisper({ s, onChange }: { s: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const st = useSyncExternalStore(subscribeWhisper, whisperStatus);
  const [prog, setProg] = useState<WhisperProgress | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    void refreshWhisper();
    const un = onWhisperDownload((p) => setProg(p.done ? null : p));
    return () => void un.then((f) => f());
  }, []);

  // Pencere kapatılıp açılırsa süren indirme arka uçtan öğrenilir.
  const downloading = active ?? st?.downloading ?? null;
  const download = async (id: string) => {
    setMsg(null);
    setActive(id);
    try {
      await api.whisperDownload(id);
      const now = await refreshWhisper();
      if (!now?.models.some((m) => m.id === s.whisperModel)) onChange({ whisperModel: id });
      setMsg({ text: "Model indirildi ve kullanıma hazır" });
    } catch (e) {
      const t = String(e);
      if (!t.includes("iptal")) setMsg({ text: t, err: true });
      void refreshWhisper();
    } finally {
      setActive(null);
      setProg(null);
    }
  };
  const remove = async (id: string) => {
    try {
      await api.whisperDeleteModel(id);
      await refreshWhisper();
    } catch (e) {
      setMsg({ text: String(e), err: true });
    }
  };

  const pct = prog && prog.total > 0 ? Math.min(100, (prog.received / prog.total) * 100) : null;
  const sizeOf = (id: string) => st?.models.find((m) => m.id === id)?.size ?? 0;
  const ready = modelInstalled(s.whisperModel);

  const downloadCuda = async () => {
    setMsg(null);
    setActive("cuda");
    try {
      await api.whisperDownloadCuda();
      await refreshWhisper();
      onChange({ whisperGpu: true });
      setMsg({ text: "Ekran kartı paketi kuruldu; çeviri artık ekran kartında yapılacak" });
    } catch (e) {
      const t = String(e);
      if (!t.includes("iptal")) setMsg({ text: t, err: true });
      void refreshWhisper();
    } finally {
      setActive(null);
      setProg(null);
    }
  };
  const removeCuda = async () => {
    try {
      await api.whisperDeleteCuda();
      await refreshWhisper();
    } catch (e) {
      setMsg({ text: String(e), err: true });
    }
  };
  const cudaBusy = downloading === "cuda";
  const progBox = (
    <div className="wm-prog">
      <div className="wm-bar">
        <div style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="muted tnum wm-pct">{prog?.item === "engine" ? "Motor…" : pct != null ? `%${Math.floor(pct)}` : "…"}</span>
      <button className="btn small ghost" onClick={() => void api.whisperCancelDownload()}>
        İptal
      </button>
    </div>
  );

  return (
    <Card
      title="Yerel Whisper"
      hint="whisper.cpp bu bilgisayarda çalışır: internet ve anahtar gerekmez, istek sınırı yoktur. Hız işlemciye bağlıdır; ilk indirmede motor (~8 MB) da kurulur."
    >
      <Row
        label="Model"
        desc={ready ? "Seçili model hazır. Başka bir model indirip seçebilirsiniz." : "Kullanmak için bir model indirin; Türkçe için en üstteki önerilen modelle başlayın."}
        aside={ready ? <span className="s-pill ok">hazır</span> : <span className="s-pill warn">model yok</span>}
        wide
      >
        <div className="wm-list">
          {WHISPER_MODELS.map((m) => {
            const have = modelInstalled(m.id);
            const sel = s.whisperModel === m.id && have;
            const busy = downloading === m.id;
            return (
              <div key={m.id} className={"wm-row" + (sel ? " sel" : "")}>
                <button className="wm-pick" disabled={!have} onClick={() => onChange({ whisperModel: m.id })} title={have ? "Bu modeli kullan" : "Önce indirin"}>
                  <span className={"wm-radio" + (sel ? " on" : "")} />
                  <span className="wm-text">
                    <span className="wm-name">{m.label}</span>
                    <span className="wm-note">{m.note}</span>
                  </span>
                </button>
                <span className="wm-size muted tnum">{have ? fmtMB(sizeOf(m.id)) : m.size}</span>
                {busy ? (
                  progBox
                ) : have ? (
                  <button className="btn small ghost danger" onClick={() => void remove(m.id)} disabled={!!downloading}>
                    Sil
                  </button>
                ) : (
                  <button className="btn small" onClick={() => void download(m.id)} disabled={!!downloading}>
                    İndir
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <Status msg={msg} />
      </Row>
      <Row
        label="Hızlandırma"
        desc={
          !st?.gpu
            ? "NVIDIA ekran kartı bulunamadı; çeviri işlemcide yapılır."
            : st.cuda
              ? `${st.gpu} kullanılabilir. Ekran kartında çeviri işlemciye göre çok daha hızlıdır.`
              : `${st.gpu} bulundu. Ekran kartı paketi (~670 MB, CUDA dahil) indirilirse çeviri çok daha hızlı olur.`
        }
        aside={st?.cuda ? <span className="s-pill ok">CUDA kurulu</span> : undefined}
        wide
      >
        {st?.gpu && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {st.cuda ? (
              <>
                <Segmented
                  value={s.whisperGpu !== false ? "gpu" : "cpu"}
                  options={[
                    { v: "gpu", label: "Ekran kartı" },
                    { v: "cpu", label: "İşlemci" },
                  ]}
                  onChange={(v) => onChange({ whisperGpu: v === "gpu" })}
                />
                <button className="btn small ghost danger" onClick={() => void removeCuda()} disabled={!!downloading}>
                  Paketi sil
                </button>
              </>
            ) : cudaBusy ? (
              progBox
            ) : (
              <button className="btn small" onClick={() => void downloadCuda()} disabled={!!downloading}>
                Ekran kartı paketini indir
              </button>
            )}
          </div>
        )}
      </Row>
    </Card>
  );
}

/** Whisper'ın sık kullanılan dilleri (ISO-639-1). */
const VOICE_LANGS: { v: string; label: string }[] = [
  { v: "", label: "Genel konuşma diliyle aynı" },
  { v: "tr", label: "Türkçe" },
  { v: "en", label: "İngilizce" },
  { v: "de", label: "Almanca" },
  { v: "fr", label: "Fransızca" },
  { v: "es", label: "İspanyolca" },
  { v: "it", label: "İtalyanca" },
  { v: "ru", label: "Rusça" },
  { v: "ar", label: "Arapça" },
  { v: "az", label: "Azerbaycan Türkçesi" },
  { v: "nl", label: "Felemenkçe" },
  { v: "pt", label: "Portekizce" },
  { v: "ja", label: "Japonca" },
];

const VOICE_KEY_ROWS: { a: VoiceKeyAction; label: string; ctx: "rec" | "idle" | "both" }[] = [
  { a: "toggle", label: "Her yerden kayıt başlat / bitir", ctx: "both" },
  { a: "record", label: "Yeni kayıt (Ses kayıtları sekmesinde)", ctx: "idle" },
  { a: "finish", label: "Kaydı bitir", ctx: "rec" },
  { a: "cancel", label: "Kaydı iptal et (silinir)", ctx: "rec" },
  { a: "pause", label: "Kayıtta duraklat / sürdür", ctx: "rec" },
  { a: "play", label: "Çal / duraklat (seçili parçadan)", ctx: "idle" },
  { a: "rerecord", label: "Seçili parçayı yeniden al", ctx: "idle" },
  { a: "remove", label: "Seçili parçayı sil", ctx: "idle" },
];

/** Ses kaydı kısayolları: tıkla, yeni birleşime bas. */
function VoiceKeysEditor({ s, onChange }: { s: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const keys = voiceKeys(s);
  const [cap, setCap] = useState<VoiceKeyAction | null>(null);
  const set = (a: VoiceKeyAction, combo: string | null) => {
    const next = { ...(s.voiceKeys ?? {}) };
    if (combo === null || combo === DEFAULT_VOICE_KEYS[a]) delete next[a];
    else next[a] = combo;
    onChange({ voiceKeys: next });
  };
  const dup = (a: VoiceKeyAction, ctx: string) =>
    VOICE_KEY_ROWS.some((r) => r.a !== a && keys[r.a] && keys[r.a] === keys[a] && (r.ctx === ctx || r.ctx === "both" || ctx === "both"));
  return (
    <div className="s-keys">
      {VOICE_KEY_ROWS.map(({ a, label, ctx }) => (
        <div key={a} className="s-key">
          <span>{label}</span>
          <button
            data-keycapture
            className={"s-key-btn" + (cap === a ? " capturing" : "") + (dup(a, ctx) ? " dup" : "")}
            title={dup(a, ctx) ? "Bu kısayol aynı anda geçerli başka bir işlemle çakışıyor" : "Değiştirmek için tıklayın"}
            onClick={() => setCap(cap === a ? null : a)}
            onBlur={() => setCap((c) => (c === a ? null : c))}
            onKeyDown={(e) => {
              if (cap !== a) return;
              e.preventDefault();
              e.stopPropagation();
              const combo = comboFromEvent(e);
              if (!combo) return;
              set(a, combo);
              setCap(null);
            }}
          >
            {cap === a ? "Tuşa basın…" : <kbd>{prettyCombo(keys[a])}</kbd>}
          </button>
          <button
            className={"icon-btn" + (s.voiceKeys?.[a] ? " show" : "")}
            onClick={() => set(a, null)}
            title={`Varsayılana dön (${prettyCombo(DEFAULT_VOICE_KEYS[a])})`}
            aria-label="Varsayılana dön"
          >
            ↺
          </button>
        </div>
      ))}
    </div>
  );
}

/** Mikrofon seçimi + canlı seviye testi. Cihaz adları ilk izinden sonra görünür. */
function MicPicker({ s, onChange }: { s: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState("");
  const stop = useRef<(() => void) | null>(null);

  const refresh = () => listMics().then(setMics).catch(() => {});
  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
      stop.current?.();
    };
  }, []);

  const test = async () => {
    if (testing) {
      stop.current?.();
      return;
    }
    setErr("");
    try {
      const stream = await openMic({
        deviceId: s.voiceDeviceId,
        noiseSuppression: s.voiceNoiseSuppression,
        echoCancellation: s.voiceEchoCancel,
        autoGainControl: s.voiceAutoGain,
      });
      void refresh();
      const m = levelMeter(stream);
      let raf = 0;
      const loop = () => {
        setLevel(m.level());
        raf = requestAnimationFrame(loop);
      };
      loop();
      setTesting(true);
      stop.current = () => {
        cancelAnimationFrame(raf);
        m.close();
        stream.getTracks().forEach((t) => t.stop());
        stop.current = null;
        setTesting(false);
        setLevel(0);
      };
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const db = level > 0 ? 20 * Math.log10(level) : -60;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const known = !s.voiceDeviceId || mics.some((m) => m.id === s.voiceDeviceId);
  return (
    <div className="mic-picker">
      <div className="mic-row">
        <select
          className="input"
          value={s.voiceDeviceId}
          onChange={(e) => {
            stop.current?.();
            onChange({ voiceDeviceId: e.target.value });
          }}
        >
          <option value="">Sistem varsayılanı</option>
          {!known && <option value={s.voiceDeviceId}>Seçili mikrofon (takılı değil)</option>}
          {mics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button className={"btn" + (testing ? " primary" : "")} onClick={test}>
          {testing ? "Testi durdur" : "Mikrofonu test et"}
        </button>
      </div>
      {testing && (
        <div className={"vr-meter" + (level > 0.97 ? " clip" : "")}>
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      {testing && <span className="s-status ok">Konuşun: çubuk yeşilde ve sarıda gezinmeli; kırmızıya vuruyorsa mikrofon kazancını düşürün.</span>}
      {err && <span className="s-status err">{err}</span>}
    </div>
  );
}

/** Gizli anahtar girişi: göster/gizle, kaydet/sil. */
function KeyInput({ saved, placeholder, onSave }: { saved: boolean; placeholder: string; onSave: (key: string) => Promise<void> }) {
  const [val, setVal] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSave(val);
      setVal("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="s-key">
      <div className="s-key-field">
        <input
          className="input"
          type={show ? "text" : "password"}
          value={val}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && val.trim() && submit()}
          placeholder={saved ? "•••••••• (değiştirmek için yeni anahtar)" : placeholder}
        />
        <button className="s-key-eye" onClick={() => setShow(!show)} title={show ? "Gizle" : "Göster"} aria-label={show ? "Anahtarı gizle" : "Anahtarı göster"}>
          <Ico n={show ? "eyeOff" : "eye"} size={15} />
        </button>
      </div>
      {val.trim() ? (
        <button className="btn primary" onClick={submit} disabled={busy}>Kaydet</button>
      ) : (
        <button className="btn danger" onClick={submit} disabled={!saved || busy}>Sil</button>
      )}
    </div>
  );
}

/** Aşama düzenleyici: ad, renk, sıra, ekle/sil. */
function StageEditor({ stages, onChange }: { stages: StageDef[]; onChange: (s: StageDef[]) => void }) {
  const set = (i: number, patch: Partial<StageDef>) => onChange(stages.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="stage-editor">
      {stages.map((st, i) => (
        <div key={st.id} className="se-row">
          <input type="color" value={st.color} onChange={(e) => set(i, { color: e.target.value })} aria-label="Renk" />
          <input className="input" value={st.label} spellCheck={false} onChange={(e) => set(i, { label: e.target.value })} />
          <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Yukarı" aria-label="Yukarı taşı">↑</button>
          <button className="icon-btn" disabled={i === stages.length - 1} onClick={() => move(i, 1)} title="Aşağı" aria-label="Aşağı taşı">↓</button>
          <button className="icon-btn" disabled={stages.length <= 1} onClick={() => onChange(stages.filter((_, j) => j !== i))} title="Sil" aria-label="Aşamayı sil">×</button>
        </div>
      ))}
      <div className="se-foot">
        <button className="btn small" onClick={() => onChange([...stages, { id: crypto.randomUUID().slice(0, 8), label: "Yeni aşama", color: "#6c8cff" }])}>＋ Aşama ekle</button>
        <button className="btn small ghost" onClick={() => onChange(DEFAULT_STAGES)}>
          <Ico n="reset" size={12} /> Varsayılana dön
        </button>
      </div>
    </div>
  );
}

/** Her satır bir madde; yazarken ham metin korunur, boş satırlar kaydedilirken atlanır. */
function ChecklistEditor({ items, onChange }: { items: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(items.join("\n"));
  return (
    <textarea
      className="input"
      rows={6}
      spellCheck={false}
      placeholder="Her satıra bir madde…"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split("\n").map((l) => l.trim()).filter(Boolean));
      }}
    />
  );
}

export function SettingsDialog({ settings: s, models, hasKey, hasGroqKey, hasYoutubeKey, onChange, onModels, onKeyChanged, onGroqKeyChanged, onYoutubeKeyChanged, onClose }: Props) {
  const [section, setSection] = useState<Section>("ai");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [groqMsg, setGroqMsg] = useState<Msg>(null);
  const [ytMsg, setYtMsg] = useState<Msg>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Arama: eşleşen bölümler öne çıkar, ilk eşleşen bölüme geçilir.
  const q = query.trim().toLocaleLowerCase("tr");
  const matches = useMemo(
    () => new Set(SECTIONS.filter((x) => !q || `${x.label} ${x.hint} ${x.keywords}`.toLocaleLowerCase("tr").includes(q)).map((x) => x.id)),
    [q],
  );
  useEffect(() => {
    if (q && !matches.has(section) && matches.size) setSection([...matches][0]);
  }, [q, matches, section]);

  const go = (id: Section) => {
    setSection(id);
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const saveKey = async (key: string) => {
    try {
      await api.setApiKey(key);
      onKeyChanged(!!key.trim());
      setMsg({ text: key.trim() ? "Anahtar kaydedildi" : "Anahtar silindi" });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    }
  };

  const saveGroqKey = async (key: string) => {
    try {
      await api.setGroqKey(key);
      onGroqKeyChanged(!!key.trim());
      setGroqMsg({ text: key.trim() ? "Groq anahtarı kaydedildi" : "Groq anahtarı silindi" });
    } catch (e) {
      setGroqMsg({ text: String(e), err: true });
    }
  };

  const saveYoutubeKey = async (key: string) => {
    try {
      await api.setYoutubeKey(key);
      onYoutubeKeyChanged(!!key.trim());
      setYtMsg({ text: key.trim() ? "YouTube anahtarı kaydedildi" : "YouTube anahtarı silindi" });
    } catch (e) {
      setYtMsg({ text: String(e), err: true });
    }
  };

  const testYoutubeKey = async () => {
    setYtBusy(true);
    setYtMsg(null);
    try {
      await api.testYoutubeKey();
      setYtMsg({ text: "Anahtar geçerli" });
    } catch (e) {
      setYtMsg({ text: String(e), err: true });
    } finally {
      setYtBusy(false);
    }
  };

  const [codexVersion, setCodexVersion] = useState("");
  const [apiModels, setApiModels] = useState<string[]>([]);
  const useCodex = s.aiProvider === "codex";
  const fetchModels = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (useCodex) {
        const info = await api.codexStatus(s.codexPath);
        setCodexVersion(info.version);
        onModels(info.models);
        setMsg(info.authenticated
          ? { text: `${info.version} · Oturum açık · ${info.models.length} katalog modeli` }
          : { text: "Codex oturumu kapalı. Terminalde codex login çalıştırın.", err: true });
      } else {
        const m = await api.listModels(s.baseUrl);
        setApiModels(m);
        onModels(m);
        setMsg({ text: `Bağlantı başarılı · ${m.length} model` });
      }
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(false);
    }
  };

  /** Kaydırıcı: dolu iz, değer rozeti ve varsayılandan farklıysa sıfırlama düğmesi. */
  const range = (k: keyof Settings, label: string, min: number, max: number, step: number, fmt: (v: number) => string = String, desc?: ReactNode) => {
    const v = s[k] as number;
    const def = DEFAULT_SETTINGS[k] as number;
    const pct = ((v - min) / (max - min)) * 100;
    return (
      <Row
        label={label}
        desc={desc}
        aside={
          <span className="s-row-aside">
            {Math.abs(v - def) > 1e-9 && (
              <button className="s-reset" onClick={() => onChange({ [k]: def })} title={`Varsayılan: ${fmt(def)}`} aria-label="Varsayılana dön">
                <Ico n="reset" size={12} />
              </button>
            )}
            <b className="s-value">{fmt(v)}</b>
          </span>
        }
        wide
      >
        <input
          className="s-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={v}
          style={{ "--p": `${pct}%` } as React.CSSProperties}
          onChange={(e) => onChange({ [k]: Number(e.target.value) })}
        />
      </Row>
    );
  };

  const fontSel = (k: "uiFont" | "readFont" | "writeFont", label: string, sample: string) => (
    <div className="s-font">
      <div className="s-font-preview" style={{ fontFamily: fontCss(s[k]) }}>
        <span className="s-font-aa">Aa</span>
        <span className="s-font-sample">{sample}</span>
      </div>
      <div className="s-font-label">{label}</div>
      <select className="input" value={s[k]} onChange={(e) => onChange({ [k]: e.target.value })}>
        {FONT_OPTIONS.map((f) => (
          <option key={f.label}>{f.label}</option>
        ))}
      </select>
    </div>
  );

  const promptBox = (k: "systemPrompt" | "insightPrompt", rows: number) => {
    const custom = s[k] !== DEFAULT_SETTINGS[k];
    return (
      <div className="s-prompt">
        <textarea className="input mono" rows={rows} spellCheck={false} value={s[k]} onChange={(e) => onChange({ [k]: e.target.value })} />
        <div className="s-prompt-foot">
          <span className={"s-pill " + (custom ? "warn" : "ok")}>{custom ? "Özelleştirilmiş" : "Varsayılan"}</span>
          <span className="muted tnum">{s[k].length.toLocaleString("tr-TR")} karakter</span>
          <span className="spacer" />
          <button className="btn small ghost" disabled={!custom} onClick={() => onChange({ [k]: DEFAULT_SETTINGS[k] })}>
            <Ico n="reset" size={12} /> Varsayılana dön
          </button>
        </div>
      </div>
    );
  };

  const localProvider = ["localhost", "127.0.0.1", "[::1]"].includes(hostOf(s.baseUrl).replace(/:\d+$/, ""));
  const needsKey = !hasKey && !localProvider;
  const aiReady = useCodex ? !!codexVersion && !msg?.err : !needsKey && !!s.model;
  const whisper = useSyncExternalStore(subscribeWhisper, whisperStatus);
  const speechReady = s.sttEngine === "local" ? !!whisper && modelInstalled(s.whisperModel) : hasGroqKey;
  const navState: Record<Section, "ok" | "warn" | null> = {
    ai: aiReady ? "ok" : "warn",
    speech: speechReady ? "ok" : s.sttEngine === "local" ? "warn" : null,
    voice: null,
    home: s.statsSource === "api" && !hasYoutubeKey ? "warn" : null,
    prompts: s.systemPrompt !== DEFAULT_SETTINGS.systemPrompt || s.insightPrompt !== DEFAULT_SETTINGS.insightPrompt ? "warn" : null,
    look: null,
  };
  const navTitle: Record<Section, string> = {
    ai: aiReady ? "Hazır" : useCodex ? "Codex oturumunu denetle" : needsKey ? "API anahtarı girilmedi" : "Model seçilmedi",
    speech: s.sttEngine === "local" ? (speechReady ? "Yerel Whisper hazır" : "Yerel model indirilmedi") : hasGroqKey ? "Groq anahtarı kayıtlı" : "Groq anahtarı yok",
    voice: "",
    home: s.statsSource === "api" && !hasYoutubeKey ? "API modu için YouTube anahtarı gerekli" : "",
    prompts: navState.prompts ? "Özelleştirilmiş istem var" : "",
    look: "",
  };

  const body: Record<Section, ReactNode> = {
    ai: (
      <>
        <div className={"s-hero " + (aiReady ? "ok" : "warn")}>
          <div className="s-hero-dot" />
          <div className="s-hero-text">
            <div className="s-hero-title">{aiReady ? "Yapay zekâ hazır" : useCodex ? "Codex CLI" : needsKey ? "API anahtarı gerekli" : "Bir model seçin"}</div>
            <div className="s-hero-sub">
              {useCodex ? codexVersion || "ChatGPT oturumu" : hostOf(s.baseUrl)}
              {useCodex ? ` · ${s.codexModel || "CLI varsayılanı"}` : s.model ? ` · ${s.model}` : ""}
              {models.length ? ` · ${models.length} model listelendi` : ""}
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={fetchModels}>
            <Ico n="refresh" size={14} /> {busy ? "Bağlanıyor…" : "Bağlantıyı test et"}
          </button>
        </div>
        <Status msg={msg} />

        <Card title="AI sağlayıcısı">
          <Row label="Metin işleme sağlayıcısı">
            <Segmented value={s.aiProvider} options={[{ v: "codex", label: "Codex CLI" }, { v: "api", label: "OpenAI uyumlu API" }]}
              onChange={(aiProvider) => { setMsg(null); setCodexVersion(""); onModels([]); onChange({ aiProvider }); }} />
          </Row>
        </Card>

        {useCodex && <Card title="Codex CLI" hint="Codex mevcut ChatGPT veya CLI oturumuyla çalışır.">
          <Row label="Çalıştırılabilir dosya" wide>
            <input className="input mono" value={s.codexPath} onChange={(e) => { setCodexVersion(""); onChange({ codexPath: e.target.value }); }} placeholder="codex" />
          </Row>
          <Row label="Metin modeli" desc="Boşsa Codex varsayılanı." wide>
            <ModelPicker value={s.codexModel} models={models} onChange={(v) => onChange({ codexModel: v })} />
          </Row>
          <Row label="Açıklama modeli" wide>
            <ModelPicker value={s.codexInsightModel} models={models} onChange={(v) => onChange({ codexInsightModel: v })} placeholder="(metin modeliyle aynı)" />
          </Row>
          <Row label="Muhakeme eforu">
            <select className="input" value={s.codexEffort} onChange={(e) => onChange({ codexEffort: e.target.value })}>
              {["", "low", "medium", "high", "xhigh", "max", "ultra"].map((v) => <option key={v} value={v}>{v || "Varsayılan"}</option>)}
            </select>
          </Row>
          {range("codexTimeoutSec", "Zaman aşımı", 30, 1800, 30, (v) => `${v} sn`)}
          <Row label="API’ye geçiş" desc="Codex CLI ya da oturum kullanılamazsa yapılandırılmış API sağlayıcısı kullanılır.">
            <Segmented value={s.codexApiFallback ? "on" : "off"} options={[{ v: "off", label: "Kapalı" }, { v: "on", label: "Açık" }]}
              onChange={(v) => onChange({ codexApiFallback: v === "on" })} />
          </Row>
        </Card>}

        <Card title={useCodex ? "API yedeği" : "Bağlantı"} hint="OpenAI uyumlu herhangi bir sunucu kullanılabilir.">
          <Row label="Sağlayıcı" desc="Hızlı seçim; adres aşağıda düzenlenebilir." wide>
            <div className="s-chips">
              {PROVIDERS.map((p) => (
                <button key={p.name} className={"s-chip-btn" + (sameUrl(s.baseUrl, p.url) ? " on" : "")} onClick={() => onChange({ baseUrl: p.url })}>
                  {p.name}
                </button>
              ))}
            </div>
          </Row>
          <Row label="API adresi" wide>
            <input className="input mono" spellCheck={false} value={s.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
          </Row>
          <Row
            label="API anahtarı"
            desc="Sistemin güvenli anahtar deposunda saklanır; yerel sunucularda gerekmeyebilir."
            aside={hasKey && <span className="s-pill ok">kayıtlı</span>}
            wide
          >
            <KeyInput saved={hasKey} placeholder="sk-…" onSave={saveKey} />
          </Row>
        </Card>

        <Card title="Modeller">
          <Row label="Metin işleme" desc="Altyazıyı Türkçe anlatıma çeviren model." wide>
            <ModelPicker value={s.model} models={useCodex ? apiModels : models} onChange={(v) => onChange({ model: v })} />
          </Row>
          <Row label="Açıklama" desc="Seçili ifadeyi açıklar; boşsa metin işleme modeli kullanılır." wide>
            <ModelPicker value={s.insightModel} models={useCodex ? apiModels : models} onChange={(v) => onChange({ insightModel: v })} placeholder="(metin işleme modeliyle aynı)" />
          </Row>
        </Card>

        <Card title="Davranış">
          {range("temperature", "Sıcaklık", 0, 1.5, 0.05, (v) => v.toFixed(2), <span className="s-scale"><span>Tutarlı</span><span>Yaratıcı</span></span>)}
          {range("chunkChars", "Parça boyutu", 2000, 20000, 500, (v) => `${v.toLocaleString("tr-TR")} karakter`, "Altyazı bu uzunlukta parçalar halinde işlenir. Büyük parça daha az istek, küçük parça daha az kesinti demektir.")}
        </Card>
      </>
    ),
    speech: (
      <>
        <Card title="Ses → yazı" hint="Ses kayıtları ve eklenen ses/video dosyaları seçilen motorla kelime kelime zamanlı metne çevrilir.">
          <Row label="Motor" desc="Groq: hızlı ve bulutta; ücretsiz anahtar ve internet gerekir, dakikalık istek sınırı vardır. Yerel: bu bilgisayarda, internetsiz ve sınırsız.">
            <Segmented<SttEngine>
              value={s.sttEngine}
              options={[
                { v: "groq", label: "Groq" },
                { v: "local", label: "Yerel Whisper" },
              ]}
              onChange={(v) => onChange({ sttEngine: v })}
            />
          </Row>
          <Row label="Konuşma dili" desc="Boş bırakılırsa otomatik algılanır (ör. tr, en).">
            <input className="input s-narrow" spellCheck={false} value={s.sttLanguage} onChange={(e) => onChange({ sttLanguage: e.target.value.trim() })} placeholder="otomatik" />
          </Row>
        </Card>
        {s.sttEngine === "local" && <LocalWhisper s={s} onChange={onChange} />}
        <Card title="Groq Whisper" hint={s.sttEngine === "groq" ? "Şu an kullanılan motor." : "Groq'a geri dönmek isterseniz anahtar burada saklanır."}>
          <Row label="Groq API anahtarı" aside={hasGroqKey && <span className="s-pill ok">kayıtlı</span>} desc="console.groq.com üzerinden ücretsiz alınabilir." wide>
            <KeyInput saved={hasGroqKey} placeholder="gsk_…" onSave={saveGroqKey} />
          </Row>
          <Status msg={groqMsg} />
        </Card>
        <Card title="YouTube" hint="YouTube 'istek sınırı' (HTTP 429) hatası verirse, giriş yaptığınız tarayıcının çerezleri kullanılabilir. Tarayıcıyı kapatmanız gerekmez.">
          <Row label="Çerez kaynağı" desc="Firefox'ta YouTube'a giriş yapmış olmanız gerekir.">
            <Segmented
              value={s.cookiesBrowser === "firefox" ? "firefox" : "none"}
              options={[
                { v: "none", label: "Yok" },
                { v: "firefox", label: "Firefox" },
              ]}
              onChange={(v) => onChange({ cookiesBrowser: v === "firefox" ? "firefox" : "" })}
            />
          </Row>
        </Card>
      </>
    ),
    voice: (
      <>
        <Card title="Mikrofon" hint="Senaryo sekmesinin yanındaki 'Ses kayıtları' bölümünde parça parça kayıt alınır.">
          <Row label="Kayıt cihazı" desc="Cihaz adları ilk mikrofon izninden sonra listelenir." wide>
            <MicPicker s={s} onChange={onChange} />
          </Row>
          <Row label="Gürültü bastırma" desc="Fan, klima gibi sabit arka plan seslerini azaltır. Sessiz bir odada kapatmak daha doğal ses verir.">
            <Segmented value={s.voiceNoiseSuppression ? "on" : "off"} options={[{ v: "off", label: "Kapalı" }, { v: "on", label: "Açık" }]} onChange={(v) => onChange({ voiceNoiseSuppression: v === "on" })} />
          </Row>
          <Row label="Yankı engelleme" desc="Hoparlörden gelen sesi kayıttan çıkarır; kulaklıkla kayıtta gerekmez.">
            <Segmented value={s.voiceEchoCancel ? "on" : "off"} options={[{ v: "off", label: "Kapalı" }, { v: "on", label: "Açık" }]} onChange={(v) => onChange({ voiceEchoCancel: v === "on" })} />
          </Row>
          <Row label="Otomatik kazanç" desc="Ses seviyesini kendiliğinden ayarlar; seslendirmede dalgalanmaya yol açabilir.">
            <Segmented value={s.voiceAutoGain ? "on" : "off"} options={[{ v: "off", label: "Kapalı" }, { v: "on", label: "Açık" }]} onChange={(v) => onChange({ voiceAutoGain: v === "on" })} />
          </Row>
        </Card>
        <Card title="Kayıt">
          <Row label="Geri sayım" desc="Kayda başlamadan önce nefes alacak kadar süre.">
            <Segmented
              value={String(s.voiceCountdown) as "0" | "1" | "3"}
              options={[
                { v: "0", label: "Yok" },
                { v: "1", label: "1 sn" },
                { v: "3", label: "3 sn" },
              ]}
              onChange={(v) => onChange({ voiceCountdown: Number(v) })}
            />
          </Row>
          {range("voiceGapMs", "Parçalar arası boşluk", 0, 2000, 50, (v) => `${(v / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 2 })} sn`, "Tümü art arda çalınırken, tek dosyada birleştirilirken ve zamanlı metne aktarılırken parçaların arasına konan sessizlik.")}
        </Card>
        <Card title="Yazıya çevirme" hint={(s.sttEngine === "local" ? "Yerel Whisper" : "Groq Whisper") + " kullanılır (motor 'Ses ve YouTube' bölümünden seçilir). Parçalar tek tek değil, birleştirilip toplu gönderilir."}>
          <Row label="Kayıt dili" desc="Konuştuğunuz dil. Doğru dil seçmek tanımayı belirgin biçimde iyileştirir.">
            <select className="input s-narrow" value={VOICE_LANGS.some((l) => l.v === s.voiceLanguage) ? s.voiceLanguage : "__custom"} onChange={(e) => e.target.value !== "__custom" && onChange({ voiceLanguage: e.target.value })}>
              {VOICE_LANGS.map((l) => (
                <option key={l.v} value={l.v}>
                  {l.label}
                </option>
              ))}
              {!VOICE_LANGS.some((l) => l.v === s.voiceLanguage) && <option value="__custom">{s.voiceLanguage}</option>}
            </select>
          </Row>
          <Row label="Kayıttan sonra otomatik çevir" desc="Her parça kaydedilir kaydedilmez arka planda yazıya çevrilir.">
            <Segmented value={s.voiceAutoTranscribe ? "on" : "off"} options={[{ v: "off", label: "Kapalı" }, { v: "on", label: "Açık" }]} onChange={(v) => onChange({ voiceAutoTranscribe: v === "on" })} />
          </Row>
        </Card>
        <Card title="Kısayollar" hint="Değiştirmek için kısayola tıklayıp yeni tuş birleşimine basın. Ok tuşları parça seçer, Home başa döner.">
          <VoiceKeysEditor s={s} onChange={onChange} />
        </Card>
      </>
    ),
    home: (
      <>
        <Card title="Video verisi" hint="Ana sayfadaki izlenme, süre ve yükleme tarihi her açılışta güncellenir.">
          <Row label="Veri kaynağı" desc="yt-dlp anahtar gerektirmez; API daha hızlıdır ve engellenmez. Otomatik: önce yt-dlp, alınamayanlar için API." wide>
            <Segmented<StatsSource>
              value={s.statsSource}
              options={[
                { v: "ytdlp", label: "yt-dlp" },
                { v: "api", label: "YouTube API" },
                { v: "auto", label: "Otomatik" },
              ]}
              onChange={(v) => onChange({ statsSource: v })}
            />
          </Row>
          <Row label="YouTube API anahtarı" desc="Google Cloud'da YouTube Data API v3'ü etkinleştirip anahtar oluşturun. Sistemin güvenli anahtar deposunda saklanır." aside={hasYoutubeKey && <span className="s-pill ok">kayıtlı</span>} wide>
            <KeyInput saved={hasYoutubeKey} placeholder="AIza…" onSave={saveYoutubeKey} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn small" disabled={!hasYoutubeKey || ytBusy} onClick={testYoutubeKey}>
                <Ico n="refresh" size={12} /> {ytBusy ? "Sınanıyor…" : "Bağlantıyı test et"}
              </button>
              <Status msg={ytMsg} />
            </div>
          </Row>
        </Card>
        <Card title="Aşamalar" hint="Projelerin ana aşamaları. Otomatik aşama ve tahmin kuralları ilk dört varsayılan aşamanın kimliklerini kullanır (Fikir, Altyazı alındı, İşlendi, Script yazılıyor); bunları silerseniz ilgili geçiş çalışmaz.">
          <StageEditor stages={s.stages} onChange={(stages) => onChange({ stages })} />
          <Row label="Otomatik aşama" desc="Altyazı alınınca “Altyazı alındı”, işleme bitince “İşlendi” olur. Yalnızca ileri taşır; elle seçtiğiniz daha ileri aşamaya dokunmaz.">
            <Segmented
              value={s.autoStage ? "on" : "off"}
              options={[
                { v: "on", label: "Açık" },
                { v: "off", label: "Kapalı" },
              ]}
              onChange={(v) => onChange({ autoStage: v === "on" })}
            />
          </Row>
        </Card>
        <Card title="Varsayılan kontrol listesi" hint="Her yeni projeye bu maddeler kopyalanır.">
          <ChecklistEditor items={s.defaultChecklist} onChange={(v) => onChange({ defaultChecklist: v })} />
        </Card>
      </>
    ),
    prompts: (
      <>
        <Card title="Yazım stilim" hint="Videoları kendi anlatım dilinizle yeniden yazın.">
          <Row label="Yazım stilimi kullan" desc="Yalnızca açıkken ve örnek dosya varsa kullanılır.">
            <Segmented value={s.styleEnabled ? "on" : "off"} options={[{ v: "off", label: "Kapalı" }, { v: "on", label: "Açık" }]} onChange={(v) => onChange({ styleEnabled: v === "on" })} />
          </Row>
          <StyleReferencesEditor items={s.styleReferences ?? []} onChange={(styleReferences) => onChange({ styleReferences })} />
        </Card>
        <Card title="Metin işleme" hint="Altyazıyı konu konu düzenleyip Türkçe anlatıma çeviren ana talimat. Zaman işareti kuralı her parçaya ayrıca eklenir.">
          {promptBox("systemPrompt", 14)}
        </Card>
        <Card title="Seçim açıklaması" hint="Kaynak metinden seçilen ifadeyi açıklayan talimat.">
          {promptBox("insightPrompt", 6)}
        </Card>
      </>
    ),
    look: (
      <>
        <Card title="Yazı tipleri">
          <div className="s-fonts">
            {fontSel("uiFont", "Arayüz", "Menüler ve düğmeler")}
            {fontSel("readFont", "Okuma", "Kaynak metin")}
            {fontSel("writeFont", "Yazma", "Senaryo editörü")}
          </div>
        </Card>
        <Card title="Metin düzeni">
          <div
            className="s-preview"
            style={{ fontFamily: fontCss(s.readFont), fontSize: s.fontSize, lineHeight: s.lineHeight }}
          >
            Peki ama neden? Şimdi bu soruya birlikte bakacağız; önce kısa bir geçmişle başlayalım.
          </div>
          {range("fontSize", "Yazı boyutu", 13, 26, 1, (v) => `${v} px`)}
          {range("lineHeight", "Satır aralığı", 1.3, 2.2, 0.05, (v) => v.toFixed(2))}
          {range("textWidth", "Metin genişliği", 480, 1100, 20, (v) => `${v} px`)}
        </Card>
        <Card title="Paneller">
          {range("splitRatio", "Sol / sağ oranı", 0.25, 0.75, 0.01, (v) => `%${Math.round(v * 100)}`, "Video paneli yokken kullanılır; bölme çubuğunu sürükleyerek de değiştirebilirsiniz.")}
          {range("segmentTint", "Bölüm renk yoğunluğu", 0, 0.3, 0.01, (v) => `%${Math.round((v / 0.3) * 100)}`)}
        </Card>
      </>
    ),
  };

  const current = SECTIONS.find((x) => x.id === section)!;

  return (
    <div className="modal-back s-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Ayarlar">
        <nav className="s-nav">
          <div className="s-nav-title">Ayarlar</div>
          <div className="s-search">
            <Ico n="search" size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ayar ara…" spellCheck={false} />
          </div>
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              className={"s-nav-item" + (section === x.id ? " on" : "") + (matches.has(x.id) ? "" : " dim")}
              onClick={() => go(x.id)}
            >
              <span className="s-nav-ico"><Ico n={x.id} /></span>
              <span className="s-nav-text">
                <span>{x.label}</span>
                <small>{x.hint}</small>
              </span>
              {navState[x.id] && <span className={"s-dot " + navState[x.id]} title={navTitle[x.id]} />}
            </button>
          ))}
          <div className="s-nav-foot">
            <Ico n="check" size={13} /> Değişiklikler otomatik kaydedilir
          </div>
        </nav>
        <div className="s-main">
          <div className="s-head">
            <div>
              <h3>{current.label}</h3>
              <p>{current.hint}</p>
            </div>
            <button className="s-close" onClick={onClose} aria-label="Kapat" title="Kapat (Esc)">
              <Ico n="close" size={16} />
            </button>
          </div>
          <div className="s-body" key={section} ref={bodyRef}>
            {body[section]}
          </div>
        </div>
      </div>
    </div>
  );
}

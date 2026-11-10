import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { FONT_OPTIONS, fontCss } from "../lib/fonts";
import { DEFAULT_SETTINGS, DEFAULT_STAGES } from "../lib/settingsDefaults";
import type { Settings, StageDef, StatsSource } from "../lib/types";

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

type Section = "ai" | "speech" | "home" | "prompts" | "look";
type Msg = { text: string; err?: boolean } | null;

// ---- İkonlar (tek renk, çizgi) ----
const PATHS: Record<string, string> = {
  ai: "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
  speech: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
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
  { id: "speech", label: "Ses ve YouTube", hint: "Groq Whisper, çerezler", keywords: "groq whisper ses konuşma dil stt youtube çerez cookie firefox 429" },
  { id: "home", label: "Ana sayfa", hint: "Aşamalar, video verisi", keywords: "ana sayfa aşama kontrol listesi izlenme yt-dlp youtube api anahtar pano kart otomatik" },
  { id: "prompts", label: "İstemler", hint: "AI talimatları", keywords: "istem prompt talimat sistem açıklama insight" },
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

  const fetchModels = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await api.listModels(s.baseUrl);
      onModels(m);
      setMsg({ text: `Bağlantı başarılı · ${m.length} model` });
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

  const aiReady = hasKey && !!s.model;
  const navState: Record<Section, "ok" | "warn" | null> = {
    ai: aiReady ? "ok" : "warn",
    speech: hasGroqKey ? "ok" : null,
    home: s.statsSource === "api" && !hasYoutubeKey ? "warn" : null,
    prompts: s.systemPrompt !== DEFAULT_SETTINGS.systemPrompt || s.insightPrompt !== DEFAULT_SETTINGS.insightPrompt ? "warn" : null,
    look: null,
  };
  const navTitle: Record<Section, string> = {
    ai: aiReady ? "Hazır" : !hasKey ? "API anahtarı girilmedi" : "Model seçilmedi",
    speech: hasGroqKey ? "Groq anahtarı kayıtlı" : "Groq anahtarı yok",
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
            <div className="s-hero-title">{aiReady ? "Yapay zekâ hazır" : !hasKey ? "API anahtarı gerekli" : "Bir model seçin"}</div>
            <div className="s-hero-sub">
              {hostOf(s.baseUrl)}
              {s.model ? ` · ${s.model}` : ""}
              {models.length ? ` · ${models.length} model listelendi` : ""}
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={fetchModels}>
            <Ico n="refresh" size={14} /> {busy ? "Bağlanıyor…" : "Bağlantıyı test et"}
          </button>
        </div>
        <Status msg={msg} />

        <Card title="Bağlantı" hint="OpenAI uyumlu herhangi bir sunucu kullanılabilir.">
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
            desc="Windows Kimlik Bilgisi Yöneticisi'nde saklanır; yerel sunucularda gerekmeyebilir."
            aside={hasKey && <span className="s-pill ok">kayıtlı</span>}
            wide
          >
            <KeyInput saved={hasKey} placeholder="sk-…" onSave={saveKey} />
          </Row>
        </Card>

        <Card title="Modeller">
          <Row label="Metin işleme" desc="Altyazıyı Türkçe anlatıma çeviren model." wide>
            <ModelPicker value={s.model} models={models} onChange={(v) => onChange({ model: v })} />
          </Row>
          <Row label="Açıklama" desc="Seçili ifadeyi açıklar; boşsa metin işleme modeli kullanılır." wide>
            <ModelPicker value={s.insightModel} models={models} onChange={(v) => onChange({ insightModel: v })} placeholder="(metin işleme modeliyle aynı)" />
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
        <Card title="Groq Whisper" hint="Ses ve video dosyalarını kelime kelime zamanlı metne çevirir.">
          <Row label="Groq API anahtarı" aside={hasGroqKey && <span className="s-pill ok">kayıtlı</span>} desc="console.groq.com üzerinden ücretsiz alınabilir." wide>
            <KeyInput saved={hasGroqKey} placeholder="gsk_…" onSave={saveGroqKey} />
          </Row>
          <Status msg={groqMsg} />
          <Row label="Konuşma dili" desc="Boş bırakılırsa otomatik algılanır.">
            <input className="input s-narrow" spellCheck={false} value={s.sttLanguage} onChange={(e) => onChange({ sttLanguage: e.target.value.trim() })} placeholder="otomatik" />
          </Row>
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
          <Row label="YouTube API anahtarı" desc="Google Cloud'da YouTube Data API v3'ü etkinleştirip anahtar oluşturun. Windows Kimlik Bilgisi Yöneticisi'nde saklanır." aside={hasYoutubeKey && <span className="s-pill ok">kayıtlı</span>} wide>
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

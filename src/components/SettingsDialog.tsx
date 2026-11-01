import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { FONT_OPTIONS } from "../lib/fonts";
import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT, MAX_STYLE_EXAMPLES } from "../lib/prompts";
import { makeStylePairs, type StylePair } from "../lib/styleAlign";
import type { Settings } from "../lib/types";

/** Aday listesinde gösterilecek kısa metin. */
const clipText = (s: string, max = 140) => (s.length > max ? s.slice(0, max) + "…" : s);

/** Saniyeyi dk:sn olarak gösterir (aday zamanı için). */
const fmtMinSec = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

interface Props {
  settings: Settings;
  models: string[];
  hasKey: boolean;
  hasGroqKey: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onModels: (m: string[]) => void;
  onKeyChanged: (has: boolean) => void;
  onGroqKeyChanged: (has: boolean) => void;
  onClose: () => void;
}

type Section = "ai" | "speech" | "prompts" | "look";
const SECTIONS: { id: Section; label: string; hint: string }[] = [
  { id: "ai", label: "Yapay zekâ", hint: "Model ve anahtar" },
  { id: "speech", label: "Ses → metin", hint: "Groq Whisper" },
  { id: "prompts", label: "İstemler", hint: "AI talimatları" },
  { id: "look", label: "Görünüm", hint: "Yazı tipi ve düzen" },
];

function ModelPicker({ value, models, onChange, placeholder }: { value: string; models: string[]; onChange: (v: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState<string | null>(null);
  const shown = (q ?? "").toLowerCase();
  const list = models.filter((m) => m.toLowerCase().includes(shown)).slice(0, 200);
  return (
    <div className="model-picker">
      <input
        className="input"
        placeholder={placeholder ?? "Model ara veya yaz…"}
        value={q ?? value}
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
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bölüm başlığı + kısa açıklama */
function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="s-block">
      <header>
        <h4>{title}</h4>
        {hint && <p>{hint}</p>}
      </header>
      <div className="s-fields">{children}</div>
    </section>
  );
}

function Field({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <label className="s-field">
      <span className="s-label">
        {label}
        {aside}
      </span>
      {children}
    </label>
  );
}

function Status({ msg }: { msg: { text: string; err?: boolean } | null }) {
  if (!msg) return null;
  return <span className={"s-status " + (msg.err ? "err" : "ok")}>{msg.text}</span>;
}

export function SettingsDialog({ settings: s, models, hasKey, hasGroqKey, onChange, onModels, onKeyChanged, onGroqKeyChanged, onClose }: Props) {
  const [section, setSection] = useState<Section>("ai");
  const [key, setKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [groqMsg, setGroqMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [srcFile, setSrcFile] = useState<File | null>(null);
  const [tgtFile, setTgtFile] = useState<File | null>(null);
  const [cands, setCands] = useState<StylePair[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [pairMsg, setPairMsg] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveKey = async () => {
    try {
      await api.setApiKey(key);
      onKeyChanged(!!key.trim());
      setKey("");
      setMsg({ text: key.trim() ? "Anahtar kaydedildi (Windows Kimlik Bilgisi Yöneticisi)" : "Anahtar silindi" });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    }
  };

  const saveGroqKey = async () => {
    try {
      await api.setGroqKey(groqKey);
      onGroqKeyChanged(!!groqKey.trim());
      setGroqKey("");
      setGroqMsg({ text: groqKey.trim() ? "Groq anahtarı kaydedildi" : "Groq anahtarı silindi" });
    } catch (e) {
      setGroqMsg({ text: String(e), err: true });
    }
  };

  const fetchModels = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (key.trim()) await saveKey();
      const m = await api.listModels(s.baseUrl);
      onModels(m);
      setMsg({ text: `${m.length} model bulundu` });
    } catch (e) {
      setMsg({ text: String(e), err: true });
    } finally {
      setBusy(false);
    }
  };

  const findPairs = async () => {
    if (!srcFile || !tgtFile) return;
    try {
      const pairs = makeStylePairs(await srcFile.text(), await tgtFile.text());
      setCands(pairs);
      setPicked(new Set());
      setPairMsg(pairs.length ? `${pairs.length} aday bulundu` : "Eşleşen aday bulunamadı");
    } catch (e) {
      setPairMsg(String(e));
    }
  };

  const addPicked = () => {
    const room = Math.max(0, MAX_STYLE_EXAMPLES - s.styleExamples.length);
    const chosen = cands
      .filter((_, i) => picked.has(i))
      .slice(0, room)
      .map((p) => ({ source: p.source, target: p.target }));
    onChange({ styleExamples: [...s.styleExamples, ...chosen] });
    setPairMsg(`${chosen.length} örnek eklendi`);
    setCands([]);
    setPicked(new Set());
  };

  const togglePick = (i: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const range = (k: keyof Settings, label: string, min: number, max: number, step: number, unit = "") => (
    <Field label={label} aside={<b className="s-value">{s[k] as number}{unit}</b>}>
      <input type="range" min={min} max={max} step={step} value={s[k] as number} onChange={(e) => onChange({ [k]: Number(e.target.value) })} />
    </Field>
  );
  const fontSel = (k: "uiFont" | "readFont" | "writeFont", label: string) => (
    <Field label={label}>
      <select className="input" value={s[k]} onChange={(e) => onChange({ [k]: e.target.value })}>
        {FONT_OPTIONS.map((f) => (
          <option key={f.label}>{f.label}</option>
        ))}
      </select>
    </Field>
  );

  const body: Record<Section, ReactNode> = {
    ai: (
      <>
        <Block title="Bağlantı" hint="OpenAI uyumlu herhangi bir sunucu (OpenAI, DeepSeek, yerel modeller…)">
          <Field label="API adresi">
            <input className="input" value={s.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label="API anahtarı" aside={hasKey && <span className="s-chip">kayıtlı</span>}>
            <div className="row">
              <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "Değiştirmek için yeni anahtar" : "sk-…"} />
              <button className="btn" onClick={saveKey} disabled={!key.trim() && !hasKey}>{key.trim() ? "Kaydet" : "Sil"}</button>
            </div>
          </Field>
          <div className="row">
            <button className="btn" disabled={busy} onClick={fetchModels}>{busy ? "Çekiliyor…" : "Modelleri getir"}</button>
            <Status msg={msg} />
          </div>
        </Block>
        <Block title="Modeller">
          <Field label="Metin işleme modeli">
            <ModelPicker value={s.model} models={models} onChange={(v) => onChange({ model: v })} />
          </Field>
          <Field label="Açıklama modeli" aside={<span className="s-hint">boşsa yukarıdaki</span>}>
            <ModelPicker value={s.insightModel} models={models} onChange={(v) => onChange({ insightModel: v })} placeholder="(aynı model)" />
          </Field>
        </Block>
        <Block title="Davranış">
          {range("temperature", "Sıcaklık", 0, 1.5, 0.05)}
          {range("chunkChars", "Parça boyutu", 2000, 20000, 500, " karakter")}
        </Block>
      </>
    ),
    speech: (
      <>
        <Block title="Groq API" hint="Ses ve video dosyalarını kelime zamanlı metne çevirmek için kullanılır.">
          <Field label="Groq anahtarı" aside={hasGroqKey && <span className="s-chip">kayıtlı</span>}>
            <div className="row">
              <input className="input" type="password" value={groqKey} onChange={(e) => setGroqKey(e.target.value)} placeholder={hasGroqKey ? "Değiştirmek için yeni anahtar" : "gsk_…"} />
              <button className="btn" onClick={saveGroqKey} disabled={!groqKey.trim() && !hasGroqKey}>{groqKey.trim() ? "Kaydet" : "Sil"}</button>
            </div>
          </Field>
          <Status msg={groqMsg} />
        </Block>
        <Block title="Dil">
          <Field label="Konuşma dili" aside={<span className="s-hint">boşsa otomatik algılanır</span>}>
            <input className="input" value={s.sttLanguage} onChange={(e) => onChange({ sttLanguage: e.target.value.trim() })} placeholder="tr, en, de…" />
          </Field>
        </Block>
        <Block title="YouTube" hint="YouTube 'istek sınırı' (429) hatası alırsanız, giriş yaptığınız tarayıcının çerezlerini kullanın. Tarayıcıyı kapatmanız gerekmez.">
          <Field label="Çerez kaynağı" aside={<span className="s-hint">Firefox'ta YouTube'a giriş yapmış olun</span>}>
            <select className="input" value={s.cookiesBrowser} onChange={(e) => onChange({ cookiesBrowser: e.target.value })}>
              <option value="">Yok</option>
              <option value="firefox">Firefox</option>
            </select>
          </Field>
        </Block>
      </>
    ),
    prompts: (
      <>
        <Block title="Metin işleme" hint="Altyazıyı konu konu düzenleyen ana talimat.">
          <Field label="İstem" aside={<button className="btn small ghost" onClick={() => onChange({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>Varsayılana dön</button>}>
            <textarea className="input mono" rows={10} value={s.systemPrompt} onChange={(e) => onChange({ systemPrompt: e.target.value })} />
          </Field>
        </Block>
        <Block title="Seçim açıklaması" hint="Metinden seçilen ifadeyi açıklayan talimat.">
          <Field label="İstem" aside={<button className="btn small ghost" onClick={() => onChange({ insightPrompt: DEFAULT_INSIGHT_PROMPT })}>Varsayılana dön</button>}>
            <textarea className="input mono" rows={6} value={s.insightPrompt} onChange={(e) => onChange({ insightPrompt: e.target.value })} />
          </Field>
        </Block>
        <Block title="Anlatım tarzı" hint="Çevirinin senin üslubunda çıkması için. Boş bırakırsan hiçbir şey eklenmez.">
          <Field label="Üslup kılavuzu" aside={<span className="s-hint">cümle uzunluğu, geçiş kelimeleri, terim tercihi…</span>}>
            <textarea
              className="input"
              rows={4}
              value={s.styleGuide}
              placeholder="Ör: Kısa cümleler kur. Geçişlerde 'peki' ve 'yani' kullan. Yazılım terimlerini İngilizce bırak."
              onChange={(e) => onChange({ styleGuide: e.target.value })}
            />
          </Field>
          <Field
            label={`Örnek çiftleri (${s.styleExamples.length}/${MAX_STYLE_EXAMPLES})`}
            aside={
              <button
                className="btn small ghost"
                disabled={s.styleExamples.length >= MAX_STYLE_EXAMPLES}
                onClick={() => onChange({ styleExamples: [...s.styleExamples, { source: "", target: "" }] })}
              >
                Örnek ekle
              </button>
            }
          >
            <div className="s-examples">
              {s.styleExamples.map((ex, i) => (
                <div key={i} className="s-example">
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="Kaynak metin (orijinal)"
                    value={ex.source}
                    onChange={(e) => onChange({ styleExamples: s.styleExamples.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)) })}
                  />
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="Senin istediğin Türkçe çıktı"
                    value={ex.target}
                    onChange={(e) => onChange({ styleExamples: s.styleExamples.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)) })}
                  />
                  <button className="btn small ghost" onClick={() => onChange({ styleExamples: s.styleExamples.filter((_, j) => j !== i) })}>Sil</button>
                </div>
              ))}
            </div>
          </Field>
        </Block>
        <Block title="Altyazıdan örnek bul" hint="Orijinal ve senin Türkçe altyazı dosyalarını seç; zamana göre eşleşen adaylar listelenir. Beğendiklerini işaretleyip ekle.">
          <Field label="Kaynak altyazı (orijinal dil)">
            <input className="input" type="file" accept=".srt,.vtt" onChange={(e) => setSrcFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Senin Türkçe altyazın">
            <input className="input" type="file" accept=".srt,.vtt" onChange={(e) => setTgtFile(e.target.files?.[0] ?? null)} />
          </Field>
          <div className="row">
            <button className="btn" disabled={!srcFile || !tgtFile} onClick={findPairs}>Adayları bul</button>
            {pairMsg && <span className="s-hint">{pairMsg}</span>}
          </div>
          {cands.length > 0 && (
            <>
              <div className="s-cands">
                {cands.map((p, i) => (
                  <label key={i} className="s-cand">
                    <input type="checkbox" checked={picked.has(i)} onChange={() => togglePick(i)} />
                    <span className="s-cand-body">
                      <small className="s-hint">{fmtMinSec(p.start)}</small>
                      <span className="s-cand-src">{clipText(p.source)}</span>
                      <span className="s-cand-tgt">{clipText(p.target)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="row">
                <button className="btn primary" disabled={picked.size === 0 || s.styleExamples.length >= MAX_STYLE_EXAMPLES} onClick={addPicked}>
                  Seçilenleri ekle ({picked.size})
                </button>
                <span className="s-hint">En fazla {MAX_STYLE_EXAMPLES} örnek; şu an {s.styleExamples.length}.</span>
              </div>
            </>
          )}
        </Block>
      </>
    ),
    look: (
      <>
        <Block title="Yazı tipleri">
          <div className="s-grid3">
            {fontSel("uiFont", "Arayüz")}
            {fontSel("readFont", "Okuma")}
            {fontSel("writeFont", "Yazma")}
          </div>
        </Block>
        <Block title="Düzen">
          {range("fontSize", "Yazı boyutu", 13, 26, 1, "px")}
          {range("lineHeight", "Satır aralığı", 1.3, 2.2, 0.05)}
          {range("textWidth", "Metin genişliği", 480, 1100, 20, "px")}
          {range("splitRatio", "Sol / sağ oranı", 0.25, 0.75, 0.01)}
          {range("segmentTint", "Segment renk yoğunluğu", 0, 0.3, 0.01)}
        </Block>
      </>
    ),
  };

  const current = SECTIONS.find((x) => x.id === section)!;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings">
        <nav className="s-nav">
          <div className="s-nav-title">Ayarlar</div>
          {SECTIONS.map((x) => (
            <button key={x.id} className={"s-nav-item" + (section === x.id ? " on" : "")} onClick={() => setSection(x.id)}>
              <span>{x.label}</span>
              <small>{x.hint}</small>
            </button>
          ))}
          <div className="s-nav-foot muted">Değişiklikler otomatik kaydedilir</div>
        </nav>
        <div className="s-main">
          <div className="s-head">
            <h3>{current.label}</h3>
            <button className="icon-btn" onClick={onClose} aria-label="Kapat">✕</button>
          </div>
          <div className="s-body" key={section}>
            {body[section]}
          </div>
        </div>
      </div>
    </div>
  );
}

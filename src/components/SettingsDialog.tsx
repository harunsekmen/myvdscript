import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { FONT_OPTIONS } from "../lib/fonts";
import { DEFAULT_INSIGHT_PROMPT, DEFAULT_SYSTEM_PROMPT } from "../lib/prompts";
import type { Settings } from "../lib/types";

interface Props {
  settings: Settings;
  models: string[];
  hasKey: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onModels: (m: string[]) => void;
  onKeyChanged: (has: boolean) => void;
  onClose: () => void;
}

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

export function SettingsDialog({ settings: s, models, hasKey, onChange, onModels, onKeyChanged, onClose }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveKey = async () => {
    await api.setApiKey(key);
    onKeyChanged(!!key.trim());
    setKey("");
    setMsg({ text: key.trim() ? "API anahtarı Windows Kimlik Bilgisi Yöneticisi'ne kaydedildi" : "API anahtarı silindi" });
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

  const num = (k: keyof Settings, label: string, min: number, max: number, step: number, unit = "") => (
    <label className="field">
      <span>{label}: <b>{s[k] as number}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={s[k] as number} onChange={(e) => onChange({ [k]: Number(e.target.value) })} />
    </label>
  );
  const fontSel = (k: "uiFont" | "readFont" | "writeFont", label: string) => (
    <label className="field">
      <span>{label}</span>
      <select className="input" value={s[k]} onChange={(e) => onChange({ [k]: e.target.value })}>
        {FONT_OPTIONS.map((f) => <option key={f.label}>{f.label}</option>)}
      </select>
    </label>
  );

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <div className="modal-head">
          <span className="modal-title">Ayarlar</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body scroll">
          <h3>Yapay zekâ (OpenAI uyumlu)</h3>
          <label className="field">
            <span>API adresi (base URL)</span>
            <input className="input" value={s.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
          </label>
          <label className="field">
            <span>API anahtarı {hasKey && <span className="ok">● kayıtlı</span>}</span>
            <div className="row">
              <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "Değiştirmek için yeni anahtar yazın" : "sk-…"} />
              <button className="btn" onClick={saveKey} disabled={!key.trim() && !hasKey}>{key.trim() ? "Kaydet" : "Sil"}</button>
            </div>
          </label>
          <div className="row">
            <button className="btn" disabled={busy} onClick={fetchModels}>{busy ? "Çekiliyor…" : "Modelleri getir"}</button>
            {msg && <span className={msg.err ? "err" : "muted"}>{msg.text}</span>}
          </div>
          <label className="field">
            <span>Model (metin işleme)</span>
            <ModelPicker value={s.model} models={models} onChange={(v) => onChange({ model: v })} />
          </label>
          <label className="field">
            <span>Açıklama modeli (boşsa yukarıdaki kullanılır)</span>
            <ModelPicker value={s.insightModel} models={models} onChange={(v) => onChange({ insightModel: v })} placeholder="(aynı model)" />
          </label>
          {num("temperature", "Sıcaklık", 0, 1.5, 0.05)}
          {num("chunkChars", "Parça boyutu (karakter)", 2000, 20000, 500)}

          <h3>Sistem istemleri</h3>
          <label className="field">
            <span className="row between">Metin işleme istemi
              <button className="btn small" onClick={() => onChange({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>Varsayılana dön</button>
            </span>
            <textarea className="input mono" rows={9} value={s.systemPrompt} onChange={(e) => onChange({ systemPrompt: e.target.value })} />
          </label>
          <label className="field">
            <span className="row between">Açıklama (seçim) istemi
              <button className="btn small" onClick={() => onChange({ insightPrompt: DEFAULT_INSIGHT_PROMPT })}>Varsayılana dön</button>
            </span>
            <textarea className="input mono" rows={5} value={s.insightPrompt} onChange={(e) => onChange({ insightPrompt: e.target.value })} />
          </label>

          <h3>Görünüm</h3>
          <div className="grid3">
            {fontSel("uiFont", "Arayüz fontu")}
            {fontSel("readFont", "Okuma fontu")}
            {fontSel("writeFont", "Yazma fontu")}
          </div>
          {num("fontSize", "Font boyutu", 13, 26, 1, "px")}
          {num("lineHeight", "Satır aralığı", 1.3, 2.2, 0.05)}
          {num("textWidth", "Metin genişliği", 480, 1100, 20, "px")}
          {num("splitRatio", "Sol/sağ oranı", 0.25, 0.75, 0.01)}
          {num("segmentTint", "Segment renk yoğunluğu", 0, 0.3, 0.01)}
        </div>
      </div>
    </div>
  );
}

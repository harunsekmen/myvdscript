import { useRef, useState } from "react";
import { MAX_STYLE_CHARS, MAX_STYLE_FILES, readStyleFile, STYLE_CONTEXT_CHARS } from "../lib/styleReferences";
import type { StyleReference } from "../lib/types";

export function StyleReferencesEditor({ items, onChange }: { items: StyleReference[]; onChange: (items: StyleReference[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const total = items.reduce((sum, r) => sum + r.content.length, 0);
  const add = async (files: File[]) => {
    setBusy(true);
    const next = [...items];
    const messages: string[] = [];
    for (const file of files) {
      try {
        if (next.length >= MAX_STYLE_FILES) throw new Error(`En fazla ${MAX_STYLE_FILES} dosya eklenebilir.`);
        const reference = await readStyleFile(file);
        if (next.some((r) => r.content === reference.content)) throw new Error(`${file.name}: bu metin zaten ekli.`);
        if (next.reduce((sum, r) => sum + r.content.length, 0) + reference.content.length > MAX_STYLE_CHARS) throw new Error("Toplam 120.000 karakter sınırı aşılıyor.");
        next.push(reference);
      } catch (e) { messages.push(e instanceof Error ? e.message : String(e)); }
    }
    if (next.length !== items.length) onChange(next);
    setMessage(messages.join(" ") || `${next.length - items.length} dosya eklendi.`);
    setBusy(false);
  };
  return <div>
    <p className="muted">Önceki Türkçe video scriptlerinizi ekleyin. Etkin dosyalar yeni işlemlerde yazım stilinize örnek olur; mevcut metinler kendiliğinden değişmez. İçerik ve anlatım uzunluğu korunarak yalnızca ifade biçimi uyarlanır.</p>
    <input ref={input} type="file" accept=".txt,.md,.markdown" multiple hidden onChange={(e) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      void add(files);
    }} />
    <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
      <button className="btn small" disabled={busy || items.length >= MAX_STYLE_FILES} onClick={() => input.current?.click()}>{busy ? "Okunuyor…" : "Script dosyaları ekle"}</button>
      <span className="muted">{items.length}/{MAX_STYLE_FILES} dosya · {total.toLocaleString("tr-TR")}/120.000 karakter</span>
    </div>
    <p className="s-row-desc">TXT / MD · UTF-8 veya UTF-16. Metinler ayarlarda saklanır ve işlem sırasında seçili yapay zekâ sağlayıcısına gönderilir. Uzun örneklerin başından, ortasından ve sonundan toplam en fazla {STYLE_CONTEXT_CHARS.toLocaleString("tr-TR")} karakter kullanılır.</p>
    {items.map((r) => <div key={r.id} style={{ borderTop: "1px solid var(--border)", padding: "12px 0" }}>
      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label><input type="checkbox" checked={r.enabled} disabled={busy} onChange={(e) => onChange(items.map((item) => item.id === r.id ? { ...item, enabled: e.target.checked } : item))} /> {r.name}</label>
        <span className="muted">{r.content.length.toLocaleString("tr-TR")} karakter</span>
        <button className="btn small ghost" onClick={() => setPreview(preview === r.id ? null : r.id)} aria-expanded={preview === r.id}>Önizleme</button>
        <button className="btn small ghost danger" disabled={busy} onClick={() => onChange(items.filter((item) => item.id !== r.id))}>Kaldır</button>
      </div>
      {preview === r.id && <pre style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", font: "inherit" }}>{r.content}</pre>}
    </div>)}
    {message && <p role="status">{message}</p>}
  </div>;
}

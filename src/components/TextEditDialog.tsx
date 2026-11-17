import { useEffect, useState } from "react";
import { editSegments, type TextEdit } from "../lib/textEdit";
import type { Segment } from "../lib/types";

export function TextEditDialog({ segments, onApply, onClose }: { segments: Segment[]; onApply: (segments: Segment[]) => void; onClose: () => void }) {
  const [options, setOptions] = useState<TextEdit>({ kind: "replace", find: "", replacement: "", all: true, matchCase: true });
  const [note, setNote] = useState("");
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [onClose]);
  const apply = (all: boolean) => {
    const result = editSegments(segments, { ...options, all });
    if (!result.count) { setNote("Eşleşme veya değişiklik bulunamadı."); return; }
    onApply(result.segments);
    setNote(`${result.count} değişiklik uygulandı. Önceki sürüme Yeniden işle menüsünden dönebilirsiniz.`);
  };
  return <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal prompt-modal">
      <div className="modal-head"><span className="modal-title">Toplu metin düzeltme</span></div>
      <div className="modal-body">
        <p className="muted">Etkin kaynağın bölüm metinlerini düzenler. Her işlem önceki sürümü geçmişe kaydeder.</p>
        <label>İşlem<select className="input" value={options.kind} onChange={(e) => setOptions({ ...options, kind: e.target.value as TextEdit["kind"] })}>
          <option value="replace">Bul ve değiştir</option><option value="upper">BÜYÜK HARFE ÇEVİR</option><option value="lower">küçük harfe çevir</option>
        </select></label>
        {options.kind === "replace" && <>
          <label>Bul<input className="input" autoFocus value={options.find} onChange={(e) => setOptions({ ...options, find: e.target.value })} /></label>
          <label>Yerine yaz<input className="input" value={options.replacement} onChange={(e) => setOptions({ ...options, replacement: e.target.value })} /></label>
          <label><input type="checkbox" checked={options.matchCase} onChange={(e) => setOptions({ ...options, matchCase: e.target.checked })} /> Büyük/küçük harfe duyarlı</label>
        </>}
        <p role="status" className="muted">{note}</p>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Kapat</button>
        {options.kind === "replace" && <button className="btn" disabled={!options.find} onClick={() => apply(false)}>İlkini değiştir</button>}
        <button className="btn primary" disabled={options.kind === "replace" && !options.find} onClick={() => apply(true)}>{options.kind === "replace" ? "Tümünü değiştir" : "Tüm metne uygula"}</button>
      </div>
    </div>
  </div>;
}

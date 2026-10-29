import { useEffect, useRef, useState } from "react";

function useEsc(onCancel: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
}

export function ConfirmDialog(p: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEsc(p.onCancel);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && p.onCancel()}>
      <div className="modal small-modal">
        <div className="modal-head"><span className="modal-title">{p.title}</span></div>
        <div className="modal-body"><p>{p.message}</p></div>
        <div className="modal-foot">
          <button className="btn" onClick={p.onCancel}>Vazgeç</button>
          <button className={"btn " + (p.danger ? "danger-fill" : "primary")} onClick={p.onConfirm} autoFocus>
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TextDialog(p: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(p.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEsc(p.onCancel);
  useEffect(() => ref.current?.select(), []);
  const submit = () => v.trim() && p.onSubmit(v.trim());
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && p.onCancel()}>
      <div className="modal small-modal">
        <div className="modal-head"><span className="modal-title">{p.title}</span></div>
        <div className="modal-body">
          {p.label && <label className="muted">{p.label}</label>}
          <input
            ref={ref}
            className="input"
            autoFocus
            placeholder={p.placeholder}
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={p.onCancel}>Vazgeç</button>
          <button className="btn primary" disabled={!v.trim()} onClick={submit}>{p.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

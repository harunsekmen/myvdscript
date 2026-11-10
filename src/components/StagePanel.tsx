import { useEffect, useRef, useState } from "react";
import type { ProjectPatch } from "../lib/api";
import { resolveStage } from "../lib/home";
import type { CheckItem, StageDef } from "../lib/types";

/** Aşama hapı: renkli nokta + ad. */
export function StagePill({ stages, id, onClick, title }: { stages: StageDef[]; id: string | undefined; onClick?: (e: React.MouseEvent) => void; title?: string }) {
  const st = resolveStage(stages, id);
  const style = { "--c": st.color } as React.CSSProperties;
  const body = (
    <>
      <i />
      {st.label}
    </>
  );
  return onClick ? (
    <button className="stage-pill" style={style} onClick={onClick} title={title ?? "Aşamayı değiştir"}>
      {body}
    </button>
  ) : (
    <span className="stage-pill" style={style}>
      {body}
    </span>
  );
}

interface Props {
  stages: StageDef[];
  stage: string | undefined;
  checklist: CheckItem[];
  note: string;
  onChange: (patch: ProjectPatch) => void;
}

const newId = () => crypto.randomUUID();

/** Aşama seçici + düzenlenebilir kontrol listesi + not. Kart açılır penceresinde ve proje içinde ortak kullanılır. */
export function StagePanel({ stages, stage, checklist, note, onChange }: Props) {
  const [text, setText] = useState("");
  const [noteDraft, setNoteDraft] = useState(note);
  const [dragId, setDragId] = useState<string | null>(null);
  const noteRef = useRef(note);
  const draftRef = useRef(note);
  draftRef.current = noteDraft;
  const current = resolveStage(stages, stage).id;

  // Dışarıdan not değişirse (başka yerden düzenlendi) taslağı eşitle.
  useEffect(() => {
    noteRef.current = note;
    setNoteDraft(note);
  }, [note]);
  // Pencere kapanırken (bileşen sökülürken) bekleyen not kaydedilir.
  useEffect(
    () => () => {
      if (draftRef.current !== noteRef.current) onChangeRef.current({ note: draftRef.current });
    },
    [],
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setList = (next: CheckItem[]) => onChange({ checklist: next });
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setList([...checklist, { id: newId(), text: t, done: false }]);
    setText("");
  };
  const move = (from: string, to: string) => {
    if (from === to) return;
    const a = checklist.findIndex((c) => c.id === from);
    const b = checklist.findIndex((c) => c.id === to);
    if (a < 0 || b < 0) return;
    const next = [...checklist];
    const [it] = next.splice(a, 1);
    next.splice(b, 0, it);
    setList(next);
  };
  const commitNote = () => {
    if (noteDraft !== noteRef.current) {
      noteRef.current = noteDraft;
      onChange({ note: noteDraft });
    }
  };

  return (
    <div className="stage-panel" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="sp-label">Aşama</div>
      <div className="sp-stages">
        {stages.map((s) => (
          <button key={s.id} className={s.id === current ? "on" : ""} style={{ "--c": s.color } as React.CSSProperties} onClick={() => onChange({ stage: s.id })}>
            <i />
            {s.label}
          </button>
        ))}
      </div>

      <div className="sp-label">
        Kontrol listesi
        {checklist.length > 0 && (
          <span className="muted tnum">
            {checklist.filter((c) => c.done).length}/{checklist.length}
          </span>
        )}
      </div>
      <div className="sp-list">
        {checklist.map((c) => (
          <div
            key={c.id}
            className={"sp-item" + (c.done ? " done" : "") + (dragId === c.id ? " drag" : "")}
            draggable
            onDragStart={(e) => {
              setDragId(c.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId) move(dragId, c.id);
              setDragId(null);
            }}
            onDragEnd={() => setDragId(null)}
          >
            <span className="sp-grip" aria-hidden="true">⋮⋮</span>
            <input type="checkbox" checked={c.done} onChange={() => setList(checklist.map((x) => (x.id === c.id ? { ...x, done: !x.done } : x)))} />
            <input
              className="sp-text"
              defaultValue={c.text}
              spellCheck={false}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== c.text) setList(checklist.map((x) => (x.id === c.id ? { ...x, text: v } : x)));
                else e.target.value = c.text;
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <button className="sp-del" onClick={() => setList(checklist.filter((x) => x.id !== c.id))} title="Sil" aria-label="Maddeyi sil">
              ×
            </button>
          </div>
        ))}
        <div className="sp-add">
          <input
            className="input"
            placeholder="Madde ekle…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="btn small" disabled={!text.trim()} onClick={add}>
            Ekle
          </button>
        </div>
      </div>

      <div className="sp-label">Not</div>
      <textarea
        className="input sp-note"
        rows={2}
        placeholder="Kısa not…"
        value={noteDraft}
        onChange={(e) => setNoteDraft(e.target.value)}
        onBlur={commitNote}
      />
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { providerOptions } from "../lib/aiProvider";
import { api, CancelledError, streamChat } from "../lib/api";
import { chapterText, emptyPublish, estimateChapters, estimateSeconds, parseChapterText, publishRequest, readPublishReply, scriptSrt, textOf, validWpm, type PublishAction } from "../lib/publish";
import type { Project, PublishMeta, Settings, ShortDraft } from "../lib/types";

interface Props {
  project: Project;
  settings: Settings;
  selection: string;
  getDoc: () => JSONContent | null;
  onChange: (change: (current: PublishMeta) => PublishMeta) => void;
  onWpm: (value: number) => void;
  onClearSelection: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

const lines = (text: string) => text.split("\n");
const updateShort = (meta: PublishMeta, id: string, patch: Partial<ShortDraft>) => ({
  ...meta, shorts: meta.shorts.map((item) => item.id === id ? { ...item, ...patch } : item),
});

function PublishField({ title, value, onEdit, action, onRun, disabled, onCopy }: {
  title: string;
  value: string;
  onEdit: (v: string) => void;
  action?: PublishAction;
  onRun?: (action: PublishAction) => void;
  disabled?: boolean;
  onCopy: (text: string) => void;
}) {
  const id = useId();
  return <section className="publish-field">
    <div className="publish-field-head">
      <label htmlFor={id}>{title}</label>
      {action && <button className="btn small" disabled={disabled} onClick={() => onRun?.(action)}>Üret</button>}
      <button className="btn small" disabled={!value.trim()} onClick={() => onCopy(value)}>Kopyala</button>
    </div>
    <textarea rows={4} id={id} className="input" value={value} disabled={disabled} onChange={(e) => onEdit(e.target.value)} />
  </section>;
}

export function PublishPane({ project, settings, selection, getDoc, onChange, onWpm, onClearSelection, onToast }: Props) {
  const meta = project.publish ?? emptyPublish();
  const [busy, setBusy] = useState<PublishAction | null>(null);
  const [editedChapters, setEditedChapters] = useState<string | null>(null);
  const job = useRef<ReturnType<typeof streamChat> | null>(null);
  const wpm = validWpm(settings.publishWpm);

  useEffect(() => () => job.current?.cancel(), []);

  const patch = (fields: Partial<PublishMeta>) => onChange((previous) => ({ ...previous, ...fields }));
  const copy = async (text: string) => {
    try {
      await writeText(text);
      onToast("Kopyalandı.");
    } catch (error) {
      onToast(`Kopyalanamadı: ${String(error)}`, "error");
    }
  };

  const run = async (action: PublishAction, useSelection = false) => {
    if (job.current) return;
    const doc = getDoc();
    const text = useSelection ? selection : textOf(doc);
    if (!text.trim()) {
      onToast("Önce senaryoya metin girin.", "error");
      return;
    }
    setBusy(action);
    const request = publishRequest(action, text, wpm);
    const active = streamChat({ ...providerOptions(settings, { schema: request.schema }), ...request });
    job.current = active;
    try {
      const { shorts, ...fields } = readPublishReply(await active.done, action);
      if (shorts) {
        const items = shorts.map((draft) => ({ ...draft, id: crypto.randomUUID(), createdAt: Date.now() }));
        onChange((previous) => ({ ...previous, shorts: [...items, ...previous.shorts] }));
        if (useSelection) onClearSelection();
      } else {
        const withChapters = action === "all" || action === "description";
        if (withChapters) setEditedChapters(null);
        patch({ ...fields, ...(withChapters ? { chapters: estimateChapters(doc, wpm) } : {}) });
      }
    } catch (error) {
      if (!(error instanceof CancelledError)) onToast(`Yayın çıktısı üretilemedi: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      job.current = null;
      setBusy(null);
    }
  };

  const timed = project.timed?.items.some((item) => item.k === "w" && item.w.trim());
  const exportSrt = async () => {
    try {
      const { srt, estimated } = scriptSrt(textOf(getDoc()), wpm, project.timed);
      if (!srt) {
        onToast("Altyazı için senaryo metni veya zamanlı kelime gerekiyor.", "error");
        return;
      }
      const name = project.title.replace(/[\\/:*?"<>|]/g, "-").trim() || "senaryo";
      const path = await save({ defaultPath: `${name}${estimated ? "-tahmini" : ""}.srt`, filters: [{ name: "SubRip altyazı", extensions: ["srt"] }] });
      if (!path) return;
      await api.saveTextFile(path, srt);
      onToast(estimated ? "Tahmini SRT kaydedildi." : "SRT kaydedildi.");
    } catch (error) {
      onToast(`SRT kaydedilemedi: ${String(error)}`, "error");
    }
  };
  const field = { disabled: !!busy, onRun: (action: PublishAction) => void run(action), onCopy: (text: string) => void copy(text) };
  const descriptionWithChapters = [meta.description, chapterText(meta.chapters)].filter(Boolean).join("\n\n");

  return <div className="publish-scroll">
    <div className="publish-actions">
      <button className="btn primary" disabled={!!busy} onClick={() => void run("all")}>Yayın bilgilerini üret</button>
      <button className="btn" onClick={() => void exportSrt()}>{timed ? "SRT indir" : "Tahmini SRT indir"}</button>
      {busy && <button className="btn" onClick={() => job.current?.cancel()}>İptal et</button>}
    </div>
    {busy && <div role="status">Yayın metni hazırlanıyor…</div>}
    <label className="publish-wpm">Tahmini zamanlar · {wpm} kelime/dk
      <input type="range" min={80} max={280} step={5} value={wpm} disabled={!!busy} onChange={(e) => onWpm(Number(e.target.value))} />
    </label>

    <PublishField {...field} action="titles" title="Başlık önerileri" value={meta.titles.join("\n")} onEdit={(v) => patch({ titles: lines(v) })} />
    <PublishField {...field} action="description" title="Açıklama" value={meta.description} onEdit={(description) => patch({ description })} />
    <PublishField {...field} title="Bölümler (tahmini)" value={editedChapters ?? chapterText(meta.chapters)} onEdit={(text) => {
      setEditedChapters(text);
      patch({ chapters: parseChapterText(text) });
    }} />
    <div className="publish-actions">
      <button className="btn small" disabled={!!busy} onClick={() => {
        setEditedChapters(null);
        patch({ chapters: estimateChapters(getDoc(), wpm) });
      }}>Zamanları hesapla</button>
      <button className="btn small" disabled={!descriptionWithChapters} onClick={() => void copy(descriptionWithChapters)}>Açıklama + bölümleri kopyala</button>
    </div>
    <PublishField {...field} action="tags" title="Etiketler" value={meta.tags.join("\n")} onEdit={(v) => patch({ tags: lines(v) })} />
    <PublishField {...field} action="pinnedComment" title="Sabit yorum" value={meta.pinnedComment} onEdit={(pinnedComment) => patch({ pinnedComment })} />

    <div className="publish-actions">
      <button className="btn" disabled={!!busy} onClick={() => void run("shorts")}>Shorts çıkar</button>
      {selection && <button className="btn" disabled={!!busy} onClick={() => void run("shorts", true)}>Seçimden Shorts çıkar</button>}
    </div>
    {selection && <div className="publish-selection">
      <span className="muted">{selection.slice(0, 180)}{selection.length > 180 && "…"}</span>
      <button className="btn small" onClick={onClearSelection}>Seçimi temizle</button>
    </div>}
    {meta.shorts.map((item) => {
      const editShort = (change: Partial<ShortDraft>) => onChange((previous) => updateShort(previous, item.id, change));
      return <section key={item.id} className="publish-short">
        <div className="publish-actions">
          <input className="input" aria-label="Shorts başlığı" value={item.title} disabled={!!busy} onChange={(e) => editShort({ title: e.target.value })} />
          <small className="muted">≈ {Math.round(estimateSeconds(item.text, wpm))} sn</small>
        </div>
        <PublishField {...field} title="Shorts senaryosu" value={item.text} onEdit={(text) => editShort({ text })} />
        <PublishField {...field} title="Alternatif girişler" value={item.hooks.join("\n")} onEdit={(v) => editShort({ hooks: lines(v) })} />
      </section>;
    })}
  </div>;
}

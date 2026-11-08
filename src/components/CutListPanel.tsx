import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import {
  DEFAULT_SILENCE_SEC, FPS_OPTIONS, TYPE_LABEL, acceptedRanges, cutsToText, isCutOn, keptRanges, setCutOn, sourceDuration, toEdl, toFcpxml, totalLen,
  type Cut,
} from "../lib/cutList";
import { baseName } from "../lib/subtitleExport";
import { fmtTime } from "../lib/timed";
import type { TimedDoc } from "../lib/types";

interface Props {
  doc: TimedDoc;
  cuts: Cut[];
  onDoc: (doc: TimedDoc) => void;
  onJump: (wordId: string) => void;
  onToast: (msg: string, kind?: "error" | "info") => void;
}

const fmtSaved = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)} dk ${Math.round(sec % 60)} sn` : `${sec.toFixed(1)} sn`);

/** Kesim listesi: sessizlik, dolgu sesi ve tekrar önerileri; seçilenler dışa aktarılır. */
export function CutListPanel({ doc, cuts, onDoc, onJump, onToast }: Props) {
  const [fps, setFps] = useState<number>(30);
  const prefs = doc.cuts;
  const silenceSec = prefs?.silenceSec ?? DEFAULT_SILENCE_SEC;
  const ranges = acceptedRanges(cuts, prefs);
  const saved = totalLen(ranges);
  const picked = cuts.filter((c) => isCutOn(c, prefs));

  const toggle = (c: Cut, on: boolean) => onDoc({ ...doc, cuts: setCutOn(prefs, c, on) });
  const setAll = (on: boolean) => {
    let p = prefs;
    for (const c of cuts) p = setCutOn(p, c, on);
    onDoc({ ...doc, cuts: p });
  };
  const setSilence = (v: number) => onDoc({ ...doc, cuts: { ...prefs, silenceSec: Math.min(10, Math.max(0.3, v)) } });

  const total = sourceDuration(doc.items);
  const kept = keptRanges(ranges, total);
  const name = baseName(doc.source);

  const saveAs = async (ext: string, label: string, contents: string) => {
    try {
      const path = await save({ defaultPath: `${name}-kesim.${ext}`, filters: [{ name: label, extensions: [ext] }] });
      if (!path) return;
      await api.saveTextFile(path, contents);
      onToast(`${label} kaydedildi`);
    } catch (e) {
      onToast(`Kaydedilemedi: ${e}`, "error");
    }
  };

  const copyList = async () => {
    try {
      await navigator.clipboard.writeText(cutsToText(picked));
      onToast("Kesim listesi kopyalandı");
    } catch (e) {
      onToast(`Kopyalanamadı: ${e}`, "error");
    }
  };

  return (
    <div className="cut-panel">
      <div className="cut-head">
        <span className="cut-title">✂ Kesim listesi</span>
        <span className="sug-count">{picked.length}/{cuts.length}</span>
        <span className="cut-saved" title="Seçili kesimlerle kazanılan süre">−{fmtSaved(saved)}</span>
        <span className="spacer" />
        <label className="cut-field" title="Bundan uzun boşluklar sessizlik sayılır">
          Sessizlik &gt;
          <input
            className="input cut-num"
            type="number"
            min={0.3}
            max={10}
            step={0.1}
            value={silenceSec}
            onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setSilence(e.target.valueAsNumber)}
          />
          sn
        </label>
      </div>
      <div className="cut-list">
        {cuts.length === 0 && <div className="muted cut-empty">Kesilecek bir şey bulunamadı.</div>}
        {cuts.map((c) => {
          const on = isCutOn(c, prefs);
          return (
            <div key={c.id} className={"cut-row" + (on ? "" : " off")} onClick={() => onJump(c.anchorId)} title="Kelimeye git">
              <input type="checkbox" checked={on} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(c, e.target.checked)} />
              <span className={"cut-type " + c.type}>{TYPE_LABEL[c.type]}</span>
              <span className="cut-time">{fmtTime(c.start, 1)}–{fmtTime(c.end, 1)}</span>
              <span className="cut-text">{c.text}</span>
              <span className="cut-len">{(c.end - c.start).toFixed(1)}s</span>
            </div>
          );
        })}
      </div>
      <div className="cut-foot">
        <button className="btn small" onClick={() => setAll(true)}>Tümünü seç</button>
        <button className="btn small" onClick={() => setAll(false)}>Hiçbirini seçme</button>
        <span className="spacer" />
        <button className="btn small" disabled={!picked.length} onClick={copyList} title="Seçili kesimleri zaman damgalı metin olarak kopyala">
          Listeyi kopyala
        </button>
        <button className="btn small" disabled={!picked.length} onClick={() => saveAs("txt", "Kesim listesi", cutsToText(picked))}>
          .txt
        </button>
        <select className="input cut-fps" value={fps} onChange={(e) => setFps(Number(e.target.value))} title="Kare hızı (EDL / FCPXML)">
          {FPS_OPTIONS.map((f) => (
            <option key={f} value={f}>{f} fps</option>
          ))}
        </select>
        <button
          className="btn small"
          disabled={!kept.length}
          onClick={() => saveAs("edl", "EDL", toEdl(kept, { title: name, clip: doc.source, fps }))}
          title="Korunan aralıkların CMX3600 EDL'i (DaVinci Resolve / Premiere)"
        >
          EDL
        </button>
        <button
          className="btn small"
          disabled={!kept.length}
          onClick={() => saveAs("fcpxml", "FCPXML", toFcpxml(kept, { name, clip: doc.source, fps, duration: total }))}
          title="Korunan aralıkların FCPXML 1.9'u; kaynak süresi yaklaşıktır (son kelime + pay)"
        >
          FCPXML
        </button>
      </div>
    </div>
  );
}

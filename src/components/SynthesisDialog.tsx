import { useEffect, useState } from "react";
import { activeModel } from "../lib/aiProvider";
import { formatAnchor, insertableText, sourceText, stripCitationTokens } from "../lib/synthesis";
import type { Project, Settings, Synthesis, SynthesisCitation } from "../lib/types";
import { videoIdOf } from "../lib/youtube";
import { useSynthesis } from "../hooks/useSynthesis";
import { Markdown } from "./Markdown";

export function SynthesisDialog({ project, settings, saveRun, close, seek, insert }: {
  project: Project;
  settings: Settings;
  saveRun: (run: Synthesis) => Promise<void>;
  close: () => void;
  seek: (citation: SynthesisCitation) => void;
  insert: (markdown: string) => void;
}) {
  const usable = project.sources.filter((source) => sourceText(source));
  const [chosen, setChosen] = useState(() => usable.map((s) => s.id));
  const [prompt, setPrompt] = useState("");
  const [tone, setTone] = useState("Anlatıcı");
  const [targetWords, setTargetWords] = useState(1_500);
  const [model, setModel] = useState(activeModel(settings));
  const [effort, setEffort] = useState(settings.codexEffort);
  const [selectedRun, setSelectedRun] = useState("");
  const { start, cancel, progress, preview, error } = useSynthesis(project, settings, saveRun);
  const selected = usable.filter((source) => chosen.includes(source.id));
  const runs = project.syntheses ?? [];
  const result = runs.find((run) => run.id === selectedRun) ?? runs.find((run) => run.status === "done");

  useEffect(() => {
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape" && !progress) close(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [close, progress]);

  return (
    <div className="modal-back">
      <div className="modal synthesis-modal" role="dialog" aria-modal="true" aria-labelledby="synthesis-title">
        <div className="modal-head"><span className="modal-title" id="synthesis-title">Kaynak sentezi</span></div>
        <div className="modal-body scroll">
          <fieldset className="synthesis-sources" disabled={!!progress}>
            <legend>Kaynaklar</legend>
            {project.sources.map((source, i) => {
              const available = usable.includes(source);
              return <label key={source.id}>
                <input type="checkbox" checked={available && chosen.includes(source.id)} disabled={!available} onChange={(event) => setChosen((ids) => event.target.checked ? [...ids, source.id] : ids.filter((id) => id !== source.id))} />
                {source.title || `Kaynak ${i + 1}`}{!available ? " · Altyazı veya metin ekleyin" : !source.processedAt ? " · Ham kaynak" : ""}
              </label>;
            })}
          </fieldset>
          <label>Senaryonun açısı<textarea className="input" rows={2} maxLength={1500} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!!progress} /></label>
          <div className="synthesis-options">
            <label>Ton<select className="input" value={tone} onChange={(e) => setTone(e.target.value)} disabled={!!progress}>
              {["Anlatıcı", "Sohbet", "Öğretici", "Analitik"].map((value) => <option key={value}>{value}</option>)}
            </select></label>
            <label>Hedef · {targetWords.toLocaleString("tr-TR")} kelime
              <input type="range" min={600} max={3000} step={100} value={targetWords} onChange={(e) => setTargetWords(Number(e.target.value))} disabled={!!progress} />
            </label>
            <label>Model<input className="input" maxLength={100} value={model} onChange={(e) => setModel(e.target.value)} disabled={!!progress} /></label>
            {settings.aiProvider === "codex" && <label>Düşünme düzeyi<select className="input" value={effort} disabled={!!progress} onChange={(e) => setEffort(e.target.value)}>
              <option value="">Varsayılan</option>
              {["low", "medium", "high", "xhigh", "max", "ultra"].map((value) => <option key={value}>{value}</option>)}
            </select></label>}
          </div>
          {selected.length < 2 && <small className="muted">Sentez için en az iki metin kaynağı seçin.</small>}
          {progress && <div role="status">{progress}</div>}
          {preview && <pre className="synthesis-preview">{stripCitationTokens(preview)}</pre>}
          {error && <div className="err" role="alert">{error}</div>}
          {runs.length > 0 && <label>Önceki sentezler<select className="input" value={result?.id ?? ""} onChange={(e) => setSelectedRun(e.target.value)} disabled={!!progress}>
            {!result && <option value="">Sentez seçin</option>}
            {runs.map((run) => <option key={run.id} value={run.id}>{run.title} · {run.status === "partial" ? `${run.digests.length} kayıtlı özet` : new Date(run.createdAt).toLocaleString("tr-TR")}</option>)}
          </select></label>}
          {!progress && result?.sections.map((section, index) => (
            <section key={index} className="synthesis-section">
              {section.title && <h3>{stripCitationTokens(section.title)}</h3>}
              <Markdown text={stripCitationTokens(section.text)} />
              <div className="synthesis-citations">
                {result.citations.filter((c) => c.sectionIndex === index).map((citation) => {
                  const source = project.sources.find((s) => s.id === citation.sourceId);
                  return <button className="btn small" key={citation.token} title={citation.quote} disabled={!source || !videoIdOf(source.url)} onClick={() => seek(citation)}>
                    K{citation.sourceIndex + 1} · {formatAnchor(citation.t)}{source?.title ? ` · ${source.title}` : ""}
                  </button>;
                })}
              </div>
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={progress ? cancel : close}>{progress ? "İptal et" : "Kapat"}</button>
          {!progress && result?.status === "done" && <button className="btn" onClick={() => insert(insertableText(result.sections))}>Editöre aktar</button>}
          <button className="btn primary" disabled={!!progress || selected.length < 2} onClick={() => {
            setSelectedRun("");
            void start(selected, { prompt, tone, targetWords, model, effort });
          }}>Sentezle</button>
        </div>
      </div>
    </div>
  );
}

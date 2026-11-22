import { useEffect, useRef, useState } from "react";
import { activeModel, providerOptions } from "../lib/aiProvider";
import { CancelledError, streamChat } from "../lib/api";
import { buildDigestPrompt, buildSynthesisPrompt, digestChunks, digestKey, parseSynthesis, shouldMapReduce, sourceText, validateCitations } from "../lib/synthesis";
import type { Project, Settings, Source, Synthesis } from "../lib/types";

type Options = Pick<Synthesis, "prompt" | "tone" | "targetWords" | "model" | "effort">;

export function useSynthesis(project: Project, settings: Settings, saveRun: (run: Synthesis) => Promise<void>) {
  const current = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState("");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const cancel = () => current.current?.abort();
  useEffect(() => () => current.current?.abort(), []);

  async function start(sources: Source[], options: Options) {
    if (current.current || sources.length < 2) return;
    const control = new AbortController();
    current.current = control;
    setPreview("");
    setError("");
    setProgress("Kaynaklar hazırlanıyor…");

    const run: Synthesis = {
      ...options,
      model: options.model.trim() || activeModel(settings),
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      title: options.prompt.trim().split("\n")[0]?.slice(0, 100) || "Kaynak sentezi",
      sourceIds: sources.map((s) => s.id),
      provider: settings.aiProvider,
      sections: [],
      citations: [],
      digests: [],
      status: "partial",
    };
    const provider = providerOptions(settings, { model: run.model, effort: run.effort });
    const request = async (system: string, user: string, onText?: (text: string) => void) => {
      if (control.signal.aborted) throw new CancelledError();
      const handle = streamChat({ ...provider, system, user, onText });
      control.signal.addEventListener("abort", handle.cancel, { once: true });
      try {
        const output = (await handle.done).trim();
        if (control.signal.aborted) throw new CancelledError();
        if (!output) throw new Error("Yapay zekâ boş yanıt verdi.");
        return output;
      } finally {
        control.signal.removeEventListener("abort", handle.cancel);
      }
    };

    try {
      const inputs = sources.map((source) => ({
        source, title: source.title || "İsimsiz kaynak", text: sourceText(source),
      }));
      const overhead = run.prompt.length + inputs.reduce((n, { title }) => n + title.length + 30, 1_000);
      if (shouldMapReduce(inputs.reduce((n, { text }) => n + text.length, overhead))) {
        const cached = (project.syntheses ?? []).flatMap((past) => past.digests ?? []);
        for (const [index, input] of inputs.entries()) {
          if (control.signal.aborted) throw new CancelledError();
          const hash = digestKey(input.source, input.text, run);
          const previous = cached.find((d) => d.sourceId === input.source.id && d.hash === hash);
          setProgress(`Kaynak ${index + 1}/${inputs.length} · ${previous ? "Kayıtlı özet" : "Özetleniyor"}`);
          if (previous) {
            input.text = previous.text;
          } else {
            const parts = [];
            const chunks = digestChunks(input.text);
            for (const [part, chunk] of chunks.entries()) {
              setProgress(`Kaynak ${index + 1}/${inputs.length} · Parça ${part + 1}/${chunks.length}`);
              parts.push(await request("Kaynak özeti hazırla.", buildDigestPrompt(chunk)));
            }
            const joined = parts.join("\n\n");
            if (shouldMapReduce(joined.length + 350)) throw new Error("Bir kaynağın özeti 24.000 karakteri aşıyor. Kaynağı kısaltıp tekrar deneyin.");
            input.text = parts.length > 1 ? await request("Alt özetleri birleştir.", buildDigestPrompt(joined)) : joined;
          }
          run.digests = [...run.digests, { sourceId: input.source.id, hash, text: input.text }];
          await saveRun({ ...run });
        }
      }

      setProgress("Senaryo üretiliyor…");
      const raw = await request("Türkçe video senaryosu editörüsün.", buildSynthesisPrompt(inputs, run), setPreview);
      const sections = parseSynthesis(raw);
      if (!sections.length) throw new Error("Senaryo metni bulunamadı.");
      const citations = validateCitations(sections, sources);
      await saveRun({ ...run, title: sections[0].title || run.title, sections, citations, status: "done" });
    } catch (reason) {
      if (!control.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      current.current = null;
      setProgress("");
      setPreview("");
    }
  }

  return { start, cancel, progress, preview, error };
}

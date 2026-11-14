import { inferStage } from "./home";
import type { HistoryEntry, Insight, Project, Segment, Source } from "./types";

/** Her kaynakta saklanan önceki işleme sürümü sayısı. */
export const HISTORY_MAX = 3;

/** Henüz başlığı belli olmayan projelerin geçici adları (ilk kaynağın başlığıyla değiştirilir). */
export const NEW_TITLES = ["Yeni proje", "Yükleniyor…"];

const newId = () => crypto.randomUUID();

/** Kaynağın orijinal altyazı dili ("Altyazı: de-orig" gibi işleme etiketinden); bilinmiyorsa boş. */
export function subtitleLang(s: Pick<Source, "procLabel" | "history">): string {
  for (const label of [s.procLabel, ...(s.history ?? []).map((h) => h.label)]) {
    const m = /Altyazı:\s*([a-z]{2,3})/i.exec(label ?? "");
    if (m) return m[1].toLowerCase();
  }
  return "";
}

export function makeSource(url = "", title = "", now = Date.now(), id: string = newId()): Source {
  return { id, url, title, transcriptRaw: "", segments: [], insights: [], createdAt: now };
}

/** Diskten okunan (eski ya da yeni biçimli) projeyi kaynaklı şemaya getirir. */
export function migrateProject(raw: any): Project {
  const { transcriptRaw, segments, insights, sources, ...rest } = raw ?? {};
  let list: Source[];
  if (Array.isArray(sources) && sources.length) {
    list = sources.map((s: any) => ({
      ...makeSource(s.url ?? "", s.title ?? "", s.createdAt ?? rest.createdAt ?? Date.now(), s.id ?? newId()),
      ...s,
      segments: Array.isArray(s.segments) ? s.segments : [],
      insights: Array.isArray(s.insights) ? s.insights : [],
      transcriptRaw: s.transcriptRaw ?? "",
    }));
  } else {
    // Eski proje: üst düzey url/altyazı/bölümler tek kaynağa dönüşür.
    const title = NEW_TITLES.includes(rest.title) ? "" : rest.title ?? "";
    list = [
      {
        ...makeSource(rest.url ?? "", title, rest.createdAt ?? Date.now()),
        transcriptRaw: transcriptRaw ?? "",
        segments: Array.isArray(segments) ? segments : [],
        insights: Array.isArray(insights) ? insights : [],
      },
    ];
  }
  const activeSourceId = list.some((s) => s.id === rest.activeSourceId) ? rest.activeSourceId : list[0].id;
  // Aşaması kaydedilmemiş eski projeler için içerikten tahmin edilir.
  const stage = rest.stage || inferStage({ editorDoc: rest.editorDoc, sources: list });
  return syncTopUrl({ ...rest, stage, sources: list, activeSourceId } as Project);
}

export function activeSource(p: Project): Source {
  return p.sources.find((s) => s.id === p.activeSourceId) ?? p.sources[0];
}

/** Diskteki üst düzey `url` her zaman ilk kaynağın bağlantısıdır (proje listesi bunu okur). */
export function syncTopUrl(p: Project): Project {
  const url = p.sources[0]?.url ?? "";
  return p.url === url ? p : { ...p, url };
}

export function patchSource(p: Project, sourceId: string, fn: (s: Source) => Source): Project {
  if (!p.sources.some((s) => s.id === sourceId)) return p;
  return syncTopUrl({ ...p, sources: p.sources.map((s) => (s.id === sourceId ? fn(s) : s)) });
}

export function addSource(p: Project, source: Source): Project {
  return syncTopUrl({ ...p, sources: [...p.sources, source], activeSourceId: source.id });
}

/** Kaynağı siler; son kaynak silinirse yerine boş bir kaynak konur. Etkin kaynak silinirse komşusu seçilir. */
export function removeSource(p: Project, sourceId: string, now = Date.now()): Project {
  const idx = p.sources.findIndex((s) => s.id === sourceId);
  if (idx < 0) return p;
  const rest = p.sources.filter((s) => s.id !== sourceId);
  const sources = rest.length ? rest : [makeSource("", "", now)];
  const activeSourceId =
    p.activeSourceId === sourceId ? sources[Math.min(idx, sources.length - 1)].id : p.activeSourceId;
  return syncTopUrl({ ...p, sources, activeSourceId });
}

/** Sekmede görünen ad: başlık, yoksa video kimliği/bağlantı, yoksa sıra numarası. */
export function sourceLabel(s: Source, index: number): string {
  if (s.title.trim()) return s.title.trim();
  if (s.url.trim()) return s.url.trim().replace(/^https?:\/\/(www\.)?/, "");
  return `Kaynak ${index + 1}`;
}

/** Yapıştırılan metin için başlık yoksa ilk dolu satırdan kısa bir ad üretir. */
export function titleFromText(text: string): string {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = line.trim().replace(/\s+/g, " ");
  return t.length > 60 ? t.slice(0, 57).trimEnd() + "…" : t;
}

/**
 * Yapıştırılan metni paragraflara ayırır: boş satırlar varsa paragraf sınırı onlardır (satır kaydırmaları
 * birleşir); yoksa her dolu satır ayrı paragraftır. Sonuç, bölüm metni biçimindedir (paragraflar boş satırla).
 */
export function pastedParagraphs(text: string): string {
  const norm = text.replace(/\r\n?/g, "\n").trim();
  const blocks = /\n[ \t]*\n/.test(norm) ? norm.split(/\n[ \t]*\n+/) : norm.split("\n");
  return blocks
    .map((b) => b.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Yapıştırılan metni AI'a göndermeden kaynağın metni yapar (önceki işleme varsa geçmişe girer). */
export function withPastedText(s: Source, text: string, title: string, now = Date.now()): Source {
  const seg: Segment = { id: "s0", title: title || "Metin", text: pastedParagraphs(text) };
  const next = applyProcessed(s, [seg], "Yapıştırılan metin", now);
  return { ...next, transcriptRaw: text.trim(), title: s.title.trim() || title };
}

/** Kaynağın güncel sürümünü geçmişe girecek kayda çevirir; işlenmiş bölüm yoksa null. */
export function snapshotOf(s: Source): HistoryEntry | null {
  if (!s.segments.length) return null;
  return {
    segments: s.segments,
    insights: s.insights,
    createdAt: s.processedAt ?? s.createdAt,
    label: s.procLabel ?? "Önceki sürüm",
  };
}

/**
 * Yeni işleme sonucunu kaynağa yazar. Önceki sürüm (varsa) geçmişe eklenir ve açıklamalar sıfırlanır.
 * `keepHistory`: devam ettirilen işlemin sonucunda geçmiş zaten eklenmiştir, yeniden eklenmez.
 */
export function applyProcessed(
  s: Source,
  segments: Segment[],
  label: string,
  now = Date.now(),
  keepHistory = false,
): Source {
  const snap = keepHistory ? null : snapshotOf(s);
  const history = snap ? [snap, ...(s.history ?? [])].slice(0, HISTORY_MAX) : s.history;
  return { ...s, segments, insights: [], history, processedAt: now, procLabel: label };
}

/** Geçmişteki sürümü geri getirir; o anki sürüm aynı sıraya geçmişe konur (yer değiştirme). */
export function restoreHistory(s: Source, index: number): Source {
  const hist = s.history ?? [];
  const entry = hist[index];
  if (!entry) return s;
  const snap = snapshotOf(s);
  const next = [...hist];
  if (snap) next[index] = snap;
  else next.splice(index, 1);
  return {
    ...s,
    segments: entry.segments,
    insights: entry.insights as Insight[],
    processedAt: entry.createdAt,
    procLabel: entry.label,
    history: next,
  };
}

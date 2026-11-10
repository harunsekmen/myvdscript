import type { HomeSort, ProjectMeta, StageDef, VideoStat } from "./types";
import { videoIdOf } from "./youtube";

const compact = new Intl.NumberFormat("tr", { notation: "compact", maximumFractionDigits: 1 });

/** 1234 → "1,2 B" (kompakt sayı). */
export const formatCount = (n: number) => compact.format(n).replace(/ /g, " ");

/** 1234567 → "1,2 Mn görüntüleme". */
export const formatViews = (n: number) => `${formatCount(n)} görüntüleme`;

/** 3723 → "1:02:03", 61 → "1:01". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

const UNITS: [number, string][] = [
  [365 * 86400, "yıl"],
  [30 * 86400, "ay"],
  [7 * 86400, "hafta"],
  [86400, "gün"],
  [3600, "saat"],
  [60, "dakika"],
];

/** "3 yıl önce", "az önce". */
export function timeAgo(ts: number, now = Date.now()): string {
  const sec = Math.max(0, (now - ts) / 1000);
  for (const [len, name] of UNITS) {
    if (sec >= len) return `${Math.floor(sec / len)} ${name} önce`;
  }
  return "az önce";
}

/** Son ölçümün bir öncekine göre artışı; artış yoksa null. */
export function viewDelta(stat: VideoStat | undefined): number | null {
  const h = stat?.history ?? [];
  if (h.length < 2) return null;
  const d = h[h.length - 1].views - h[h.length - 2].views;
  return d > 0 ? d : null;
}

export const formatDelta = (n: number) => `+${formatCount(n)}`;

export interface ProjectVideo {
  url: string;
  title: string;
  id: string | null;
  stat?: VideoStat;
}

export interface ProjectStats {
  videos: ProjectVideo[];
  totalViews: number | null;
  delta: number | null;
}

/** Projenin videoları ve (varsa) izlenme toplamı / artışı. */
export function projectStats(meta: ProjectMeta, stats: Record<string, VideoStat>): ProjectStats {
  const srcs = meta.sources?.length ? meta.sources : meta.url ? [{ url: meta.url, title: "" }] : [];
  const videos = srcs.map((s) => {
    const id = videoIdOf(s.url);
    return { url: s.url, title: s.title, id, stat: id ? stats[id] : undefined };
  });
  const known = videos.filter((v) => v.stat?.views != null);
  const totalViews = known.length ? known.reduce((a, v) => a + (v.stat!.views ?? 0), 0) : null;
  const deltas = videos.map((v) => viewDelta(v.stat)).filter((d): d is number => d != null);
  return { videos, totalViews, delta: deltas.length ? deltas.reduce((a, b) => a + b, 0) : null };
}

/** Aşama kimliğini tanıma: bilinmeyen kimlik ilk aşamaya düşer. */
export function resolveStage(stages: StageDef[], id: string | undefined): StageDef {
  return stages.find((s) => s.id === id) ?? stages[0] ?? { id: "idea", label: "Fikir", color: "#8a8fa3" };
}

/** TipTap belgesinde yazı ya da resim var mı? */
export function docHasContent(v: any): boolean {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(docHasContent);
  if (typeof v.text === "string" && v.text.trim()) return true;
  if ("path" in v) return true;
  return Object.values(v).some(docHasContent);
}

/** Aşaması kaydedilmemiş eski projeler için tahmin (Rust tarafındaki `infer_stage` ile aynı kural). */
export function inferStage(p: {
  editorDoc?: any;
  sources?: { transcriptRaw?: string; segments?: unknown[] }[];
}): string {
  if (docHasContent(p.editorDoc)) return "writing";
  const src = p.sources ?? [];
  if (src.some((s) => (s.segments?.length ?? 0) > 0)) return "processed";
  return "idea";
}

export interface HomeFilter {
  query: string;
  stage: string | null; // null = hepsi
  sort: HomeSort;
}

const norm = (s: string) => s.toLocaleLowerCase("tr");

/** Aranan metin başlık, not ve video başlık/kanallarında aranır. */
export function matchesQuery(m: ProjectMeta, q: string, stats: Record<string, VideoStat>): boolean {
  const needle = norm(q.trim());
  if (!needle) return true;
  const hay = [m.title, m.note, ...m.sources.map((s) => s.title)];
  for (const v of projectStats(m, stats).videos) if (v.stat) hay.push(v.stat.title, v.stat.channel);
  return hay.some((h) => norm(h ?? "").includes(needle));
}

/** Sabitlenenler her zaman önce; sonra seçilen sıralama. */
export function filterSort(
  list: ProjectMeta[],
  f: HomeFilter,
  stats: Record<string, VideoStat>,
  stages: StageDef[],
): ProjectMeta[] {
  const order = (id: string) => Math.max(0, stages.findIndex((s) => s.id === id));
  const views = (m: ProjectMeta) => projectStats(m, stats).totalViews ?? -1;
  const cmp: Record<HomeSort, (a: ProjectMeta, b: ProjectMeta) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    views: (a, b) => views(b) - views(a) || b.updatedAt - a.updatedAt,
    stage: (a, b) => order(a.stage) - order(b.stage) || b.updatedAt - a.updatedAt,
  };
  return list
    .filter((m) => (!f.stage || resolveStage(stages, m.stage).id === f.stage) && matchesQuery(m, f.query, stats))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp[f.sort](a, b));
}

/** Aşama başına proje sayısı (arşivlenenler hariç). */
export function countByStage(list: ProjectMeta[], stages: StageDef[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of list) {
    if (m.archived) continue;
    const id = resolveStage(stages, m.stage).id;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/** Aşamanın ayardaki sırası (ileri taşıma karşılaştırması için). */
export function stageRank(stages: StageDef[], id: string | undefined): number {
  const i = stages.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

/** Otomatik aşama: yalnızca ileri taşır. Hedef ya da mevcut aşama listede yoksa ya da ilerleme yoksa null. */
export function advanceStage(stages: StageDef[], current: string | undefined, target: string): string | null {
  const t = stages.findIndex((s) => s.id === target);
  if (t < 0) return null;
  const c = stages.findIndex((s) => s.id === current);
  return t > Math.max(c, 0) || (c < 0 && t > 0) ? target : null;
}

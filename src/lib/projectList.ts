import { inferStage } from "./home";
import type { Project, ProjectMeta } from "./types";

/** Açık projeden liste özeti (Rust tarafındaki `meta_of` ile aynı alanlar). */
export function metaOf(p: Project, updatedAt: number): ProjectMeta {
  const list = p.checklist ?? [];
  return {
    id: p.id,
    title: p.title,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt,
    stage: p.stage || inferStage(p),
    checkDone: list.filter((c) => c.done).length,
    checkTotal: list.length,
    checklist: list,
    note: p.note ?? "",
    pinned: !!p.pinned,
    archived: !!p.archived,
    sources: p.sources.filter((s) => s.url.trim()).map((s) => ({ url: s.url, title: s.title })),
  };
}

/**
 * Kaydedilen projeyi bellekteki listeye işler (başlık/bağlantı/zaman/aşama…) ve en yeniye göre sıralar.
 * Listede olmayan proje eklenmez (silinmiş bir projenin geç kalan kaydı listeyi geri getirmesin).
 */
export function upsertMeta(list: ProjectMeta[], p: Project, updatedAt: number): ProjectMeta[] {
  if (!list.some((m) => m.id === p.id)) return list;
  const meta = metaOf(p, updatedAt);
  return list.map((m) => (m.id === p.id ? meta : m)).sort((a, b) => b.updatedAt - a.updatedAt);
}

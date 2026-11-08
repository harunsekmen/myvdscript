import type { Project, ProjectMeta } from "./types";

/**
 * Kaydedilen projeyi bellekteki listeye işler (başlık/bağlantı/zaman) ve en yeniye göre sıralar.
 * Listede olmayan proje eklenmez (silinmiş bir projenin geç kalan kaydı listeyi geri getirmesin).
 */
export function upsertMeta(list: ProjectMeta[], p: Project, updatedAt: number): ProjectMeta[] {
  if (!list.some((m) => m.id === p.id)) return list;
  const meta: ProjectMeta = { id: p.id, title: p.title, url: p.url, createdAt: p.createdAt, updatedAt };
  return list.map((m) => (m.id === p.id ? meta : m)).sort((a, b) => b.updatedAt - a.updatedAt);
}

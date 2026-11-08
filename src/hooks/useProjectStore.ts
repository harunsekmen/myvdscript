import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { api } from "../lib/api";
import { createAutosaver, type SaveStatus } from "../lib/autosave";
import { upsertMeta } from "../lib/projectList";
import { migrateProject, syncTopUrl } from "../lib/sources";
import { normalizeTimed } from "../lib/timed";
import type { Project, ProjectMeta, Settings } from "../lib/types";

/** Diskten okunan projeyi güncel şemaya getirir (eski projeler tek kaynağa, eski kelimelere kimlik eklenir). */
export const withSchema = (raw: Project): Project => {
  const p = migrateProject(raw);
  return { ...p, timed: p.timed ? normalizeTimed(p.timed) : null };
};

/** İşleme hattının proje değişiminde çağrılan kancaları (App içinde usePipeline ile doldurulur). */
export interface PipelineLifecycle {
  cancel: () => void;
  reset: () => void;
}

interface Opts {
  patchSettings: (patch: Partial<Settings>) => void;
  lifecycle: MutableRefObject<PipelineLifecycle>;
}

/** Proje durumu: açık proje, liste, otomatik kayıt ve oluştur/aç/sil işlemleri. */
export function useProjectStore({ patchSettings, lifecycle }: Opts) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const projectRef = useRef<Project | null>(null);
  const [status, setStatus] = useState<{ s: SaveStatus; err?: string }>({ s: "idle" });

  // Kayıttan sonra listeyi diskten okumak yerine bellekteki girdi güncellenir.
  const saver = useMemo(
    () =>
      createAutosaver<Project>(
        async (p) => {
          const updatedAt = await api.saveProject(p);
          setProjects((list) => upsertMeta(list, p, updatedAt));
        },
        (s, err) => setStatus({ s, err }),
      ),
    [],
  );

  const mutate = useCallback(
    (fn: (p: Project) => Project, render = true) => {
      const cur = projectRef.current;
      if (!cur) return;
      const next = syncTopUrl(fn(cur));
      projectRef.current = next;
      if (render) setProject(next);
      saver.schedule(next);
    },
    [saver],
  );

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, []);

  const show = (p: Project | null) => {
    projectRef.current = p;
    setProject(p);
  };

  const openProject = useCallback(
    async (id: string) => {
      lifecycle.current.cancel();
      await saver.flush();
      const p = withSchema(await api.loadProject(id));
      show(p);
      lifecycle.current.reset();
      patchSettings({ lastProjectId: id });
    },
    [lifecycle, saver, patchSettings],
  );

  /** Açılışta: listeyi yükle, son projeyi (yoksa ilkini) aç. */
  const loadInitial = useCallback(
    async (lastProjectId: string) => {
      const list = await refreshProjects();
      const target = list.find((p) => p.id === lastProjectId) ?? list[0];
      if (target) show(withSchema(await api.loadProject(target.id)));
    },
    [refreshProjects],
  );

  const createProject = useCallback(
    async (title: string, url: string) => {
      const p = await api.createProject(title, url);
      await refreshProjects();
      await openProject(p.id);
      return p;
    },
    [refreshProjects, openProject],
  );

  const rename = useCallback((title: string) => mutate((p) => ({ ...p, title })), [mutate]);

  const deleteCurrent = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id) return;
    lifecycle.current.cancel();
    saver.cancel();
    await api.deleteProject(id);
    const list = await refreshProjects();
    if (list[0]) await openProject(list[0].id);
    else {
      show(null);
      lifecycle.current.reset();
    }
  }, [lifecycle, saver, refreshProjects, openProject]);

  const clearAll = useCallback(async () => {
    lifecycle.current.cancel();
    saver.cancel();
    await api.clearAll();
    show(null);
    setProjects([]);
    lifecycle.current.reset();
    patchSettings({ lastProjectId: "" });
  }, [lifecycle, saver, patchSettings]);

  return { projects, project, projectRef, status, saver, mutate, openProject, loadInitial, createProject, rename, deleteCurrent, clearAll };
}

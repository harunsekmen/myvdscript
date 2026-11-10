import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { api, type ProjectPatch } from "../lib/api";
import { createAutosaver, type SaveStatus } from "../lib/autosave";
import { upsertMeta } from "../lib/projectList";
import { migrateProject, syncTopUrl } from "../lib/sources";
import { normalizeTimed } from "../lib/timed";
import type { Project, ProjectMeta, Settings } from "../lib/types";

/** Ana sayfadan yapılan düzenlemeyi liste özetine anında yansıtır. */
export function applyPatchToMeta(m: ProjectMeta, patch: ProjectPatch): ProjectMeta {
  const next = { ...m };
  if (patch.stage !== undefined) next.stage = patch.stage;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.archived !== undefined) next.archived = patch.archived;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.checklist) {
    next.checklist = patch.checklist;
    next.checkTotal = patch.checklist.length;
    next.checkDone = patch.checklist.filter((c) => c.done).length;
  }
  return next;
}

/** Diskten okunan projeyi güncel şemaya getirir (eski projeler tek kaynağa, eski kelimelere kimlik eklenir). */
export const withSchema = (raw: Project): Project => {
  const p = migrateProject(raw);
  return { ...p, timed: p.timed ? normalizeTimed(p.timed) : null };
};

/** İşleme hattının proje değişiminde çağrılan kancaları (App içinde usePipeline ile doldurulur). */
export interface PipelineLifecycle {
  /** Projeye ait çalışan/sıradaki işlemleri durdurur; kimlik yoksa hepsini. */
  cancel: (projectId?: string) => void;
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

  /**
   * Proje açma ve arka plan güncellemeleri tek sırada çalışır: açılan proje diskten okunurken
   * arka plandaki bir yazım araya girip birbirini ezemez.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const next = chain.current.then(job);
    chain.current = next.catch(() => {});
    return next;
  }, []);

  /**
   * Herhangi bir projeyi günceller: açıksa bellekte (otomatik kayıtla), değilse diskte.
   * Arka planda işlenen (açık olmayan) projelerin sonucu böylece kaybolmaz.
   */
  const updateProject = useCallback(
    (id: string, fn: (p: Project) => Project): Promise<void> => {
      if (projectRef.current?.id === id) {
        mutate(fn);
        return Promise.resolve();
      }
      return serial(async () => {
        if (projectRef.current?.id === id) return mutate(fn);
        const cur = withSchema(await api.loadProject(id));
        const next = fn(cur);
        if (next === cur) return;
        const synced = syncTopUrl(next);
        const updatedAt = await api.saveProject(synced);
        setProjects((list) => upsertMeta(list, synced, updatedAt));
      });
    },
    [mutate, serial],
  );

  const openProject = useCallback(
    (id: string) =>
      serial(async () => {
        // Çalışan işlem iptal edilmez; arka planda kendi projesine yazmaya devam eder.
        await saver.flush();
        const p = withSchema(await api.loadProject(id));
        show(p);
        lifecycle.current.reset();
        patchSettings({ lastProjectId: id });
      }),
    [lifecycle, saver, patchSettings, serial],
  );

  /** Açılışta yalnızca liste yüklenir; proje ana sayfadan seçilince açılır. */
  const loadInitial = useCallback(async () => {
    await refreshProjects();
  }, [refreshProjects]);

  const createProject = useCallback(
    async (title: string, url: string, extra?: ProjectPatch, open = true) => {
      const p = await api.createProject(title, url);
      if (extra) await api.patchProject(p.id, extra);
      await refreshProjects();
      if (open) await openProject(p.id);
      return p;
    },
    [refreshProjects, openProject],
  );

  const rename = useCallback((title: string) => mutate((p) => ({ ...p, title })), [mutate]);

  /** Projeyi siler (açık olan da olabilir); açık proje silinirse hiçbir proje açık kalmaz. */
  const deleteById = useCallback(
    async (id: string) => {
      const open = projectRef.current?.id === id;
      lifecycle.current.cancel(id);
      if (open) saver.cancel();
      await chain.current;
      await api.deleteProject(id);
      if (open) {
        show(null);
        lifecycle.current.reset();
      }
      await refreshProjects();
    },
    [lifecycle, saver, refreshProjects],
  );

  /**
   * Ana sayfadan düzenleme: açık projeyse bellekte (otomatik kayıtla), değilse diskte yamalanır.
   * Liste özeti anında güncellenir.
   */
  const editProject = useCallback(
    async (id: string, patch: ProjectPatch) => {
      setProjects((list) => list.map((m) => (m.id === id ? applyPatchToMeta(m, patch) : m)));
      if (projectRef.current?.id === id) {
        mutate((p) => ({ ...p, ...patch }));
        return;
      }
      try {
        await api.patchProject(id, patch);
      } catch (e) {
        await refreshProjects();
        throw e;
      }
    },
    [mutate, refreshProjects],
  );

  const clearAll = useCallback(async () => {
    lifecycle.current.cancel();
    saver.cancel();
    await chain.current;
    await api.clearAll();
    show(null);
    setProjects([]);
    lifecycle.current.reset();
    patchSettings({ lastProjectId: "" });
  }, [lifecycle, saver, patchSettings]);

  return { projects, project, projectRef, status, saver, mutate, updateProject, openProject, loadInitial, createProject, rename, deleteById, editProject, clearAll };
}

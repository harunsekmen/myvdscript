import { useCallback, useEffect, useRef, useState } from "react";
import { api, onVideoStat } from "../lib/api";
import type { ProjectMeta, VideoStat } from "../lib/types";
import { videoIdOf } from "../lib/youtube";

export interface StatsProgress {
  done: number;
  total: number;
}

/** Arşivlenmemiş projelerin benzersiz video bağlantıları. */
export function collectUrls(metas: ProjectMeta[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of metas) {
    if (m.archived) continue;
    for (const s of m.sources) {
      const id = videoIdOf(s.url);
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(`https://www.youtube.com/watch?v=${id}`);
      }
    }
  }
  return out;
}

/**
 * Video istatistikleri: önce diskteki önbellek (anında), sonra oturumda bir kez (`ready` olunca) ve
 * elle "Yenile" ile arka planda güncellenir. Her video bitince kart tek tek güncellenir.
 */
export function useVideoStats(metas: ProjectMeta[], ready: boolean) {
  const [stats, setStats] = useState<Record<string, VideoStat>>({});
  const [cacheLoaded, setCacheLoaded] = useState(false);
  const [progress, setProgress] = useState<StatsProgress | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [failed, setFailed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const metasRef = useRef(metas);
  metasRef.current = metas;
  const pending = useRef<Set<string>>(new Set());
  const total = useRef(0);
  const busy = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .loadVideoStats()
      .then((c) => {
        if (!alive) return;
        setStats((cur) => ({ ...c, ...cur }));
        const t = Math.max(0, ...Object.values(c).map((v) => v.fetchedAt));
        if (t) setLastUpdated((cur) => cur ?? t);
      })
      .catch(() => {})
      .finally(() => alive && setCacheLoaded(true));
    const un = onVideoStat((s) => {
      setStats((cur) => ({ ...cur, [s.id]: s }));
      if (pending.current.delete(s.id)) setProgress({ done: total.current - pending.current.size, total: total.current });
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  const refresh = useCallback(async (only?: string[]) => {
    if (busy.current) return;
    const urls = only ?? collectUrls(metasRef.current);
    if (!urls.length) return;
    busy.current = true;
    setError(null);
    setFailed(0);
    pending.current = new Set(urls.map((u) => videoIdOf(u)!));
    total.current = urls.length;
    setProgress({ done: 0, total: urls.length });
    try {
      const got = await api.refreshVideoStats(urls);
      setStats((cur) => {
        const next = { ...cur };
        for (const s of got) next[s.id] = s;
        return next;
      });
      setFailed(Math.max(0, urls.length - got.length));
      setLastUpdated(Date.now());
    } catch (e) {
      setError(String(e));
      setFailed(urls.length);
    } finally {
      busy.current = false;
      pending.current = new Set();
      setProgress(null);
    }
  }, []);

  // Açılışta bir kez: önbellek yüklendikten ve proje listesi geldikten sonra.
  useEffect(() => {
    if (!ready || !cacheLoaded || started.current || !metas.length) return;
    started.current = true;
    collectUrls(metasRef.current).forEach((u) => tried.current.add(videoIdOf(u)!));
    void refresh();
  }, [ready, cacheLoaded, metas.length, refresh]);

  // Oturum içinde eklenen yeni videolar (yeni proje/kaynak) bir kez ayrıca yenilenir.
  const tried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!started.current || busy.current) return;
    const fresh = collectUrls(metas).filter((u) => {
      const id = videoIdOf(u)!;
      return !stats[id] && !tried.current.has(id);
    });
    if (!fresh.length) return;
    fresh.forEach((u) => tried.current.add(videoIdOf(u)!));
    void refresh(fresh);
  }, [metas, stats, refresh]);

  return { stats, progress, lastUpdated, failed, error, refresh, cacheLoaded };
}

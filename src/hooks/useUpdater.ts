import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "../lib/api";

const RELEASES = "https://github.com/harunsekmen/myvdscript/releases/latest";

export type UpdateState =
  | { status: "idle" | "checking" | "current" }
  | { status: "available"; version: string; manual: boolean }
  | { status: "installing"; version: string; progress?: number }
  | { status: "error"; message: string };

export function useUpdater(flush: () => Promise<void>) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const update = useRef<Update | null>(null);
  const locked = useRef(false);
  const checkNow = useCallback(async (showErrors = true) => {
    if (locked.current) return;
    locked.current = true;
    setState({ status: "checking" });
    try {
      await update.current?.close().catch(() => {});
      update.current = null;
      const automatic = await api.automaticUpdateSupported();
      if (automatic) {
        update.current = await check({ timeout: 12_000 });
        if (update.current) {
          setState({ status: "available", version: update.current.version, manual: false });
          return;
        }
      }
      const version = automatic ? null : await api.checkManualUpdate();
      setState(version ? { status: "available", version, manual: true } : { status: "current" });
    } catch (error) {
      setState(showErrors ? { status: "error", message: `Güncelleme denetlenemedi: ${String(error)}` } : { status: "idle" });
    } finally {
      locked.current = false;
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkNow(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [checkNow]);

  const install = async () => {
    if (state.status !== "available" || locked.current) return;
    locked.current = true;
    const version = state.version;
    try {
      if (state.manual) {
        await api.openExternal(RELEASES);
        return;
      }
      const installer = update.current;
      if (!installer) return;
      setState({ status: "installing", version });
      let total = 0;
      let received = 0;
      await flush();
      await installer.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) setState({ status: "installing", version, progress: Math.min(100, Math.round(received * 100 / total)) });
        }
      });
      await relaunch();
    } catch (error) {
      setState({ status: "error", message: `Güncelleme açılamadı: ${String(error)}` });
    } finally {
      locked.current = false;
    }
  };
  return { state, checkNow, install };
}

export type Updater = ReturnType<typeof useUpdater>;

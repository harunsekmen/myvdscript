export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/** Debounce'lı otomatik kaydedici; flush() bekleyen kaydı hemen yazar. */
export function createAutosaver<T>(save: (data: T) => Promise<unknown>, onStatus: (s: SaveStatus, err?: string) => void, delay = 600) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const run = () => {
    timer = null;
    if (latest === null) return inflight;
    const data = latest;
    latest = null;
    onStatus("saving");
    inflight = inflight
      .then(() => save(data))
      .then(() => onStatus(latest === null ? "saved" : "pending"))
      .catch((e) => onStatus("error", String(e)));
    return inflight;
  };

  return {
    schedule(data: T) {
      latest = data;
      onStatus("pending");
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await run();
      await inflight;
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}

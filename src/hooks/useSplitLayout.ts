import { useRef } from "react";
import type { Settings } from "../lib/types";

/** Bölme çubukları: sol/orta/sağ panel oranları ve sürükleme. Video yoksa tek çubuk vardır. */
export function useSplitLayout(settings: Settings, patchSettings: (patch: Partial<Settings>) => void, hasVideoPane: boolean) {
  const splitRef = useRef<HTMLDivElement>(null);
  const L = Math.min(0.6, Math.max(0.2, settings.splitLeft ?? 0.36));
  const M = Math.min(0.45, Math.max(0.18, settings.splitMid ?? 0.26));

  // which: sol bölme çubuğu ("left") ya da sağ bölme çubuğu ("right").
  const startDrag = (which: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    const box = splitRef.current!.getBoundingClientRect();
    splitRef.current!.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const x = (ev.clientX - box.left) / box.width;
      if (!hasVideoPane) return patchSettings({ splitRatio: Math.min(0.75, Math.max(0.25, x)) });
      const MIN_L = 0.2, MIN_M = 0.18, MIN_R = 0.22;
      if (which === "left") {
        // sol/orta sınırı: sağ panelin genişliği sabit kalır
        const edge = L + M;
        const left = Math.min(Math.max(x, MIN_L), edge - MIN_M);
        patchSettings({ splitLeft: left, splitMid: edge - left });
      } else {
        const mid = Math.min(Math.max(x - L, MIN_M), 1 - L - MIN_R);
        patchSettings({ splitMid: mid });
      }
    };
    const up = () => {
      splitRef.current?.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { splitRef, L, M, startDrag };
}

import { useState } from "react";
import type { Updater } from "../hooks/useUpdater";

export function UpdateBanner({ updater }: { updater: Updater }) {
  const [hiddenVersion, setHiddenVersion] = useState("");
  const { state, install } = updater;
  if (state.status === "installing") {
    return <div className="banner busy" role="status">Güncelleme kuruluyor{state.progress === undefined ? "…" : ` · %${state.progress}`}</div>;
  }
  if (state.status !== "available" || state.version === hiddenVersion) return null;
  return <div className="banner busy">
    <span>Script Atölyesi {state.version} hazır.</span>
    <button className="btn small primary" onClick={() => void install()}>{state.manual ? "İndirme sayfası" : "Güncelle"}</button>
    <button className="btn small" onClick={() => setHiddenVersion(state.version)}>Kapat</button>
  </div>;
}

import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import type { ProjectMeta } from "../lib/types";
import type { Updater } from "../hooks/useUpdater";

export function DataSettings({ projects, activeId, restore, updater }: {
  projects: ProjectMeta[];
  activeId: string | null;
  restore: (id: string | null, date: string) => Promise<void>;
  updater: Updater;
}) {
  const [projectId, setProjectId] = useState(activeId ?? "");
  const [dates, setDates] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  useEffect(() => {
    let current = true;
    setSelected("");
    setDates([]);
    setConfirm(false);
    api.listBackups(projectId || null).then((values) => {
      if (current) { setDates(values); setSelected(values[0] ?? ""); }
    }).catch((error) => {
      if (current) setMessage({ text: String(error), error: true });
    });
    return () => { current = false; };
  }, [projectId, revision]);

  const restoreSelected = async () => {
    setBusy(true);
    setConfirm(false);
    try {
      await restore(projectId || null, selected);
      setMessage({ text: "Yedek geri yüklendi." });
      setRevision((v) => v + 1);
    } catch (error) {
      setMessage({ text: `Yedek geri yüklenemedi: ${String(error)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const diagnostics = async () => {
    setBusy(true);
    try {
      const path = await save({ defaultPath: "script-atolyesi-tanilama.zip", filters: [{ name: "ZIP arşivi", extensions: ["zip"] }] });
      if (!path) return;
      await api.exportDiagnostics(path);
      setMessage({ text: "Tanılama arşivi kaydedildi." });
    } catch (error) {
      setMessage({ text: `Arşiv oluşturulamadı: ${String(error)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const { state } = updater;
  return <div className="data-settings">
    <div className="s-card">
      <strong>Yedekler</strong>
      <p className="muted">Ayarların ve projelerin günlük JSON yedekleri UTC tarihine göre tutulur. Geri yükleme öncesi mevcut sürüm ayrıca saklanır.</p>
      <label>Veri<select className="input" value={projectId} disabled={busy} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">Uygulama ayarları</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select></label>
      <label>Yedek<select className="input" value={selected} disabled={busy || !dates.length} onChange={(e) => { setSelected(e.target.value); setConfirm(false); }}>
        {!dates.length && <option value="">Kayıtlı yedek yok</option>}
        {dates.map((date) => <option key={date} value={date}>{date.startsWith("geri-") ? `Geri yükleme öncesi · ${date.slice(5)} UTC` : date}</option>)}
      </select></label>
      {confirm ? <div className="publish-actions">
        <button className="btn" onClick={() => setConfirm(false)}>Vazgeç</button>
        <button className="btn primary" onClick={() => void restoreSelected()}>Geri yüklemeyi onayla</button>
      </div> : <button className="btn" disabled={busy || !selected} onClick={() => setConfirm(true)}>Geri yükle</button>}
    </div>
    <div className="s-card">
      <strong>Tanılama</strong>
      <button className="btn" disabled={busy} onClick={() => void diagnostics()}>Tanılama dışa aktar</button>
    </div>
    <div className="s-card">
      <strong>Güncellemeler</strong>
      <div className="publish-actions">
        <button className="btn" disabled={busy || ["checking", "installing"].includes(state.status)} onClick={() => void updater.checkNow()}>Güncellemeyi denetle</button>
        {state.status === "available" && <button className="btn primary" onClick={() => void updater.install()}>{state.manual ? "İndirme sayfası" : "Güncelle"}</button>}
      </div>
      {state.status === "checking" && <small role="status">Sürüm denetleniyor…</small>}
      {state.status === "current" && <small role="status">Yeni yayımlanmış sürüm yok.</small>}
      {state.status === "available" && <small role="status">Sürüm {state.version} hazır.</small>}
      {state.status === "installing" && <small role="status">Kurulum hazırlanıyor…</small>}
      {state.status === "error" && <small className="err" role="alert">{state.message}</small>}
    </div>
    {message && <div className={message.error ? "err" : ""} role={message.error ? "alert" : "status"}>{message.text}</div>}
  </div>;
}

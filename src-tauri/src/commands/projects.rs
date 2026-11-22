use crate::store;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// TipTap belgesinde yazı ya da resim var mı?
fn doc_has_content(v: &Value) -> bool {
    match v {
        Value::Object(o) => {
            o.get("text").and_then(|t| t.as_str()).map(|t| !t.trim().is_empty()).unwrap_or(false)
                || o.contains_key("path")
                || o.values().any(doc_has_content)
        }
        Value::Array(a) => a.iter().any(doc_has_content),
        _ => false,
    }
}

/// Aşama kaydedilmemiş (eski) projeler için tahmin; ön yüzdeki `inferStage` ile aynı kural.
fn infer_stage(v: &Value) -> &'static str {
    if v.get("editorDoc").map(doc_has_content).unwrap_or(false) {
        return "writing";
    }
    let has = |key: &str, f: &dyn Fn(&Value) -> bool| match v["sources"].as_array() {
        Some(a) => a.iter().any(|s| f(&s[key])),
        None => f(&v[key]),
    };
    if has("segments", &|x| x.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
        return "processed";
    }
    "idea"
}

/// Proje listesi için gereken alanlar: başlık, bağlantılar, zamanlar, aşama, kontrol listesi özeti, not.
fn meta_of(v: &Value) -> Value {
    let list = v["checklist"].as_array();
    let total = list.map(|a| a.len()).unwrap_or(0);
    let done = list.map(|a| a.iter().filter(|c| c["done"].as_bool().unwrap_or(false)).count()).unwrap_or(0);
    let mut sources: Vec<Value> = v["sources"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|s| s["url"].as_str().map(|u| !u.trim().is_empty()).unwrap_or(false))
                .map(|s| json!({ "url": s["url"], "title": s.get("title").cloned().unwrap_or(json!("")) }))
                .collect()
        })
        .unwrap_or_default();
    if v["sources"].as_array().is_none() && v["url"].as_str().map(|u| !u.trim().is_empty()).unwrap_or(false) {
        sources.push(json!({ "url": v["url"], "title": "" }));
    }
    let stage = v["stage"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| infer_stage(v));
    json!({
        "id": v["id"], "title": v["title"], "url": v["url"],
        "createdAt": v["createdAt"], "updatedAt": v.get("updatedAt").cloned().unwrap_or(v["createdAt"].clone()),
        "stage": stage, "checkDone": done, "checkTotal": total,
        "note": v["note"].as_str().unwrap_or(""),
        "pinned": v["pinned"].as_bool().unwrap_or(false),
        "archived": v["archived"].as_bool().unwrap_or(false),
        "sources": sources,
        "checklist": v.get("checklist").cloned().unwrap_or(json!([])),
    })
}

/// Önce küçük `meta.json` okunur (büyük project.json'u ayrıştırmadan). Yoksa, bozuksa ya da eski biçimliyse
/// (`sources` alanı yok) project.json'a düşülür ve özet yeniden yazılır.
fn read_meta(dir: &std::path::Path) -> Option<Value> {
    if let Ok(text) = fs::read_to_string(dir.join("meta.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if v["id"].is_string() && v["sources"].is_array() {
                return Some(v);
            }
        }
    }
    let text = fs::read_to_string(dir.join("project.json")).ok()?;
    let v = serde_json::from_str::<Value>(&text).ok()?;
    let meta = meta_of(&v);
    if let Ok(m) = serde_json::to_vec(&meta) {
        let _ = store::write_atomic(&dir.join("meta.json"), &m);
    }
    Some(meta)
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<Value>, String> {
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(store::projects_dir()) else { return Ok(out) };
    for entry in rd.flatten() {
        if let Some(m) = read_meta(&entry.path()) {
            out.push(m);
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or(0)));
    Ok(out)
}

#[tauri::command]
pub fn create_project(title: String, url: String) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let source_id = uuid::Uuid::new_v4().simple().to_string();
    let now = now_ms();
    let project = json!({
        "id": id, "title": title, "url": url,
        "createdAt": now, "updatedAt": now,
        "sources": [{
            "id": source_id, "url": url, "title": "",
            "transcriptRaw": "", "segments": [], "insights": [], "createdAt": now,
        }],
        "activeSourceId": source_id,
        "editorDoc": null, "imageMeta": {},
    });
    save_project(project.clone())?;
    Ok(project)
}

#[tauri::command]
pub fn load_project(id: String) -> Result<Value, String> {
    let file = store::project_dir(&id)?.join("project.json");
    let text = fs::read_to_string(&file).map_err(|e| format!("Proje okunamadı: {e}"))?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| format!("Proje bozuk: {e}"))?;
    // Klasör taşınmış olabilir: resim yollarını güncel proje klasörüne çevir.
    let images = store::project_dir(&id)?.join("images");
    fix_image_paths(&mut v, &id, &images);
    Ok(v)
}

fn fix_image_paths(v: &mut Value, id: &str, images_dir: &Path) {
    let fix = |s: &str| -> Option<String> {
        let marker = format!("{id}\\images\\");
        let marker_fwd = format!("{id}/images/");
        let marker_mixed = format!("{id}/images\\");
        let name = if let Some(i) = s.find(&marker) {
            &s[i + marker.len()..]
        } else if let Some(i) = s.find(&marker_fwd) {
            &s[i + marker_fwd.len()..]
        } else {
            let i = s.find(&marker_mixed)?;
            &s[i + marker_mixed.len()..]
        };
        if name.is_empty() || matches!(name, "." | "..") || name.contains(['\\', '/', ':']) {
            return None;
        }
        Some(images_dir.join(name).to_string_lossy().into_owned())
    };
    match v {
        Value::String(s) => {
            if let Some(n) = fix(s) {
                *s = n;
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| fix_image_paths(x, id, images_dir)),
        Value::Object(o) => {
            let old = std::mem::take(o);
            for (k, mut val) in old {
                fix_image_paths(&mut val, id, images_dir);
                o.insert(fix(&k).unwrap_or(k), val);
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub fn save_project(mut project: Value) -> Result<u64, String> {
    let id = project["id"].as_str().ok_or("Proje kimliği yok")?.to_string();
    let dir = store::project_dir(&id)?;
    let now = now_ms();
    project["updatedAt"] = json!(now);
    let bytes = serde_json::to_vec_pretty(&project).map_err(|e| e.to_string())?;
    store::write_atomic(&dir.join("project.json"), &bytes)?;
    // Liste için küçük özet; yazılamazsa sorun değil (list_projects project.json'a düşer).
    if let Ok(m) = serde_json::to_vec(&meta_of(&project)) {
        let _ = store::write_atomic(&dir.join("meta.json"), &m);
    }
    Ok(now)
}

/// Ana sayfadan düzenlenebilen alanlar.
const PATCHABLE: [&str; 6] = ["stage", "checklist", "note", "pinned", "archived", "title"];

/// Yalnızca izinli alanları birleştirir; `null` alanı siler.
fn merge_patch(project: &mut Value, patch: &Value) {
    let (Some(p), Some(patch)) = (project.as_object_mut(), patch.as_object()) else { return };
    for key in PATCHABLE {
        match patch.get(key) {
            Some(Value::Null) => {
                p.remove(key);
            }
            Some(v) => {
                p.insert(key.to_string(), v.clone());
            }
            None => {}
        }
    }
}

/// Açık olmayan bir projeyi ana sayfadan düzenler (aşama, kontrol listesi, not, sabitleme, arşiv, başlık).
#[tauri::command]
pub fn patch_project(id: String, patch: Value) -> Result<u64, String> {
    let file = store::project_dir(&id)?.join("project.json");
    let text = fs::read_to_string(&file).map_err(|e| format!("Proje okunamadı: {e}"))?;
    let mut v: Value = serde_json::from_str(&text).map_err(|e| format!("Proje bozuk: {e}"))?;
    merge_patch(&mut v, &patch);
    save_project(v)
}

#[tauri::command]
pub fn delete_project(id: String) -> Result<(), String> {
    let dir = store::project_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Tüm projeleri (resimler dahil) kalıntısız siler.
#[tauri::command]
pub fn clear_all_projects() -> Result<(), String> {
    let dir = store::projects_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_paths_follow_moved_folder() {
        let old = r"C:\Old\ScriptAtolyesi\projects\abc\images\x.png";
        let mut v = json!({
            "editorDoc": { "attrs": { "path": old } },
            "imageMeta": { old: { "note": "n" } },
            "other": r"C:\Old\something.png"
        });
        let images = Path::new("moved").join("projects").join("abc").join("images");
        fix_image_paths(&mut v, "abc", &images);
        let want = images.join("x.png");
        let want = want.to_str().unwrap();
        assert_eq!(v["editorDoc"]["attrs"]["path"], want);
        assert!(v["imageMeta"].get(want).is_some());
        assert_eq!(v["other"], r"C:\Old\something.png");
    }

    #[test]
    fn image_paths_repair_posix_and_previous_macos_mixed_separators() {
        let mut v = json!([
            "/old/abc/images/kapak.png",
            "/old/abc/images\\kapak.png",
            "/old/other/images/irrelevant.png"
        ]);
        let images = Path::new("restored").join("abc").join("images");
        fix_image_paths(&mut v, "abc", &images);
        let want = images.join("kapak.png");
        assert_eq!(v[0], want.to_str().unwrap());
        assert_eq!(v[1], v[0]);
        assert_eq!(v[2], "/old/other/images/irrelevant.png");
    }

    #[test]
    fn meta_falls_back_to_project_json() {
        let dir = std::env::temp_dir().join(format!("sa-meta-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        // Yalnız project.json (eski sürüm): özet ondan çıkarılır.
        fs::write(dir.join("project.json"), r#"{"id":"a","title":"T","url":"u","createdAt":5,"updatedAt":7}"#).unwrap();
        let m = read_meta(&dir).unwrap();
        assert_eq!(m["title"], "T");
        assert_eq!(m["updatedAt"], 7);
        assert_eq!(m["stage"], "idea");
        assert_eq!(m["sources"][0]["url"], "u");
        // Eski biçimli meta.json (sources yok) project.json'a düşer; güncel meta.json kullanılır.
        fs::write(dir.join("meta.json"), r#"{"id":"a","title":"Eski","url":"u","createdAt":5,"updatedAt":9}"#).unwrap();
        assert_eq!(read_meta(&dir).unwrap()["title"], "T");
        fs::write(dir.join("meta.json"), r#"{"id":"a","title":"Yeni","url":"u","createdAt":5,"updatedAt":9,"sources":[]}"#).unwrap();
        assert_eq!(read_meta(&dir).unwrap()["title"], "Yeni");
        // Bozuk meta.json project.json'a düşer.
        fs::write(dir.join("meta.json"), "{bozuk").unwrap();
        assert_eq!(read_meta(&dir).unwrap()["title"], "T");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn meta_summarizes_new_fields() {
        let v = json!({
            "id": "a", "title": "T", "url": "u1", "createdAt": 1, "updatedAt": 2,
            "sources": [{"url": "u1", "title": "V1", "segments": [1]}, {"url": "", "title": ""}, {"url": "u2", "title": "V2"}],
            "checklist": [{"id":"1","text":"a","done":true},{"id":"2","text":"b","done":false}],
            "note": "n", "pinned": true,
        });
        let m = meta_of(&v);
        assert_eq!((m["checkDone"].as_u64(), m["checkTotal"].as_u64()), (Some(1), Some(2)));
        assert_eq!(m["sources"].as_array().unwrap().len(), 2);
        assert_eq!(m["stage"], "processed");
        assert_eq!(m["pinned"], true);
        assert_eq!(m["archived"], false);
        let w = json!({"id":"a","stage":"filmed","editorDoc":{"type":"doc","content":[{"type":"text","text":"x"}]},"sources":[]});
        assert_eq!(meta_of(&w)["stage"], "filmed");
        let w = json!({"id":"a","editorDoc":{"type":"doc","content":[{"type":"paragraph"}]},"sources":[{"transcriptRaw":"x"}]});
        assert_eq!(meta_of(&w)["stage"], "idea");
        let w = json!({"id":"a","editorDoc":{"type":"doc","content":[{"type":"text","text":"yaz"}]}});
        assert_eq!(meta_of(&w)["stage"], "writing");
    }

    #[test]
    fn patch_only_allowed_fields() {
        let mut v = json!({"id":"a","title":"T","note":"eski","sources":[1],"updatedAt":1});
        merge_patch(&mut v, &json!({"id":"b","sources":[],"note":null,"stage":"filmed","pinned":true,"title":"Yeni"}));
        assert_eq!(v["id"], "a");
        assert_eq!(v["sources"], json!([1]));
        assert!(v.get("note").is_none());
        assert_eq!(v["stage"], "filmed");
        assert_eq!(v["pinned"], true);
        assert_eq!(v["title"], "Yeni");
    }
}

use crate::store;
use serde_json::{json, Value};
use std::fs;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Proje listesi için gereken alanlar (proje başlığı, bağlantı, zamanlar).
fn meta_of(v: &Value) -> Value {
    json!({
        "id": v["id"], "title": v["title"], "url": v["url"],
        "createdAt": v["createdAt"], "updatedAt": v.get("updatedAt").cloned().unwrap_or(v["createdAt"].clone()),
    })
}

/// Önce küçük `meta.json` okunur (büyük project.json'u ayrıştırmadan); yoksa/bozuksa project.json'a düşer.
fn read_meta(dir: &std::path::Path) -> Option<Value> {
    if let Ok(text) = fs::read_to_string(dir.join("meta.json")) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if v["id"].is_string() {
                return Some(v);
            }
        }
    }
    let text = fs::read_to_string(dir.join("project.json")).ok()?;
    let v = serde_json::from_str::<Value>(&text).ok()?;
    Some(meta_of(&v))
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
    fix_image_paths(&mut v, &id, &images.to_string_lossy());
    Ok(v)
}

fn fix_image_paths(v: &mut Value, id: &str, images_dir: &str) {
    let fix = |s: &str| -> Option<String> {
        let marker = format!("{id}\\images\\");
        let marker_fwd = format!("{id}/images/");
        let name = if let Some(i) = s.find(&marker) {
            &s[i + marker.len()..]
        } else if let Some(i) = s.find(&marker_fwd) {
            &s[i + marker_fwd.len()..]
        } else {
            return None;
        };
        if name.is_empty() || name.contains(['\\', '/']) {
            return None;
        }
        Some(format!("{images_dir}\\{name}"))
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
        fix_image_paths(&mut v, "abc", r"D:\New\projects\abc\images");
        let want = r"D:\New\projects\abc\images\x.png";
        assert_eq!(v["editorDoc"]["attrs"]["path"], want);
        assert!(v["imageMeta"].get(want).is_some());
        assert_eq!(v["other"], r"C:\Old\something.png");
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
        // meta.json varsa o kullanılır.
        fs::write(dir.join("meta.json"), r#"{"id":"a","title":"Yeni","url":"u","createdAt":5,"updatedAt":9}"#).unwrap();
        assert_eq!(read_meta(&dir).unwrap()["title"], "Yeni");
        // Bozuk meta.json project.json'a düşer.
        fs::write(dir.join("meta.json"), "{bozuk").unwrap();
        assert_eq!(read_meta(&dir).unwrap()["title"], "T");
        let _ = fs::remove_dir_all(&dir);
    }
}


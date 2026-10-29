use crate::store;
use serde_json::{json, Value};
use std::fs;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<Value>, String> {
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(store::projects_dir()) else { return Ok(out) };
    for entry in rd.flatten() {
        let file = entry.path().join("project.json");
        let Ok(text) = fs::read_to_string(&file) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        out.push(json!({
            "id": v["id"], "title": v["title"], "url": v["url"],
            "createdAt": v["createdAt"], "updatedAt": v.get("updatedAt").cloned().unwrap_or(v["createdAt"].clone()),
        }));
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or(0)));
    Ok(out)
}

#[tauri::command]
pub fn create_project(title: String, url: String) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let now = now_ms();
    let project = json!({
        "id": id, "title": title, "url": url,
        "createdAt": now, "updatedAt": now,
        "transcriptRaw": "", "segments": [], "insights": [],
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
}


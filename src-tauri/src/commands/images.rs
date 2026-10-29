use crate::store;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

#[tauri::command]
pub fn save_image(project_id: String, data_base64: String, ext: String) -> Result<Value, String> {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let ext = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => ext,
        _ => "png".to_string(),
    };
    let payload = data_base64.split(',').last().unwrap_or("");
    let bytes = STANDARD.decode(payload.trim()).map_err(|e| format!("Resim çözülemedi: {e}"))?;
    let dir = store::project_dir(&project_id)?.join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Kısa, sıralı ad: resim-1.png, resim-2.png … (ilk boş numara)
    let mut n = 1;
    let name = loop {
        let candidate = format!("resim-{n}.{ext}");
        let taken = fs::read_dir(&dir)
            .map(|rd| rd.flatten().any(|e| e.path().file_stem().and_then(|s| s.to_str()) == Some(&format!("resim-{n}"))))
            .unwrap_or(false);
        if !taken {
            break candidate;
        }
        n += 1;
    };
    let path = dir.join(&name);
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "path": path.to_string_lossy(), "name": name }))
}

#[tauri::command]
pub fn read_image(path: String) -> Result<String, String> {
    let p = store::ensure_in_projects(&PathBuf::from(&path))?;
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let mime = match p.extension().and_then(|e| e.to_str()).unwrap_or("png") {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub fn delete_image(path: String) -> Result<(), String> {
    let Ok(p) = store::ensure_in_projects(&PathBuf::from(&path)) else { return Ok(()) };
    if p.is_file() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

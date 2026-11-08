use std::{fs, path::Path};

/// Kullanıcının kaydetme penceresinde seçtiği yola metin dosyası (SRT, VTT, EDL, FCPXML…) yazar.
#[tauri::command]
pub fn save_text_file(path: String, contents: String) -> Result<(), String> {
    let p = Path::new(&path);
    if path.trim().is_empty() || p.is_dir() {
        return Err("Geçersiz dosya yolu".into());
    }
    fs::write(p, contents.as_bytes()).map_err(|e| format!("Dosya yazılamadı: {e}"))
}

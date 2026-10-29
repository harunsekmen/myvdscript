use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Release'te veriler exe'nin yanındaki `ScriptAtolyesi` klasörüne yazılır (taşınabilir);
/// klasör yazılamıyorsa (ör. Program Files) ve dev derlemesinde %APPDATA% kullanılır.
pub fn pick_root(app_data: PathBuf) -> PathBuf {
    if !cfg!(debug_assertions) {
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("ScriptAtolyesi"))) {
            if fs::create_dir_all(&dir).is_ok() {
                let probe = dir.join(".write-test");
                if fs::write(&probe, b"x").is_ok() {
                    let _ = fs::remove_file(probe);
                    return dir;
                }
            }
        }
    }
    app_data.join("ScriptAtolyesi")
}

pub fn init(root: PathBuf) {
    let _ = fs::create_dir_all(root.join("projects"));
    let _ = ROOT.set(root);
}

pub fn root() -> PathBuf {
    ROOT.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("ScriptAtolyesi"))
}

pub fn projects_dir() -> PathBuf {
    root().join("projects")
}

pub fn settings_path() -> PathBuf {
    root().join("settings.json")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn project_dir(id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Geçersiz proje kimliği".into());
    }
    Ok(projects_dir().join(id))
}

/// Önce geçici dosyaya yazıp sonra yeniden adlandırır; yarım yazılmış dosya kalmaz.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Yolun proje klasörlerinin içinde olduğunu doğrular (path traversal koruması).
pub fn ensure_in_projects(path: &Path) -> Result<PathBuf, String> {
    let base = fs::canonicalize(projects_dir()).map_err(|e| e.to_string())?;
    let p = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if p.starts_with(&base) {
        Ok(p)
    } else {
        Err("Yol proje klasörünün dışında".into())
    }
}

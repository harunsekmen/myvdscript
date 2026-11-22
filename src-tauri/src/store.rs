use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};

static DATA: Mutex<()> = Mutex::new(());

pub fn lock_data() -> Result<MutexGuard<'static, ()>, String> {
    DATA.lock().map_err(|_| "Proje depolaması kilitli".into())
}

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Veriler her zaman %APPDATA%\ScriptAtolyesi altında tutulur. Exe'nin yanına yazmak, aynı uygulamanın
/// farklı kopyalarının (geliştirme derlemesi, Portable, Programlar) farklı ayarları görmesine yol açıyordu.
pub fn pick_root(app_data: PathBuf) -> PathBuf {
    app_data.join("ScriptAtolyesi")
}

/// Eski sürümler veriyi exe'nin yanındaki `ScriptAtolyesi` klasörüne yazıyordu.
/// Bir kez çalışır: ayarlar ve projeler yeni köke kopyalanır (mevcut ayar `settings.json.bak` olur).
pub fn migrate_from_exe_dir(root: &Path) {
    let marker = root.join(".migrated-from-exe-dir");
    if marker.exists() {
        return;
    }
    let Some(src) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("ScriptAtolyesi"))) else {
        return;
    };
    if !src.join("settings.json").exists() && !src.join("projects").exists() {
        return;
    }
    let _ = fs::create_dir_all(root);
    let settings = src.join("settings.json");
    if settings.exists() {
        let dest = root.join("settings.json");
        if dest.exists() {
            let _ = fs::copy(&dest, root.join("settings.json.bak"));
        }
        let _ = fs::copy(&settings, &dest);
    }
    let _ = copy_missing_dirs(&src.join("projects"), &root.join("projects"));
    let _ = fs::write(&marker, format!("{}\n", src.display()));
}

/// `src` altındaki klasörleri `dst`'ye kopyalar; hedefte zaten olan dosyalara dokunmaz.
fn copy_missing_dirs(src: &Path, dst: &Path) -> std::io::Result<()> {
    let Ok(rd) = fs::read_dir(src) else { return Ok(()) };
    fs::create_dir_all(dst)?;
    for entry in rd.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_missing_dirs(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
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
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
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

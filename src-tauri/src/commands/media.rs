use crate::{commands::transcript::run_with_retry, store};
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};
use tauri::ipc::Response;

fn media_dir() -> PathBuf {
    store::root().join("media")
}

/// Projenin ses dosyası adı öneki: proje kimliği + URL'nin özeti (URL değişirse yeniden indirilir).
fn prefix(project_id: &str, url: &str) -> String {
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    let safe: String = project_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    format!("{safe}_{:x}", h.finish())
}

fn find_cached(dir: &Path, prefix: &str) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&format!("{prefix}.")))
        })
}

/// Videonun orijinal sesini (en iyi ses akışı) proje klasörüne bir kez indirir; yolunu döndürür.
/// ffmpeg gerektirmez: yt-dlp akışı olduğu gibi kaydeder.
#[tauri::command]
pub async fn ensure_audio(project_id: String, url: String) -> Result<String, String> {
    if !url.starts_with("http") {
        return Err("Bu proje için bir video bağlantısı yok".into());
    }
    let dir = media_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pre = prefix(&project_id, &url);
    if let Some(p) = find_cached(&dir, &pre) {
        return Ok(p.to_string_lossy().to_string());
    }
    // Aynı projenin eski (farklı URL'li) önbelleklerini temizle.
    let project_key = format!("{}_", pre.rsplit_once('_').map(|(a, _)| a).unwrap_or(""));
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&project_key) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let tpl = dir.join(format!("{pre}.%(ext)s")).to_string_lossy().to_string();

    // ffmpeg varsa mp3'e çevir (yt-dlp -x); yoksa ya da çevirme başarısızsa ses olduğu gibi (m4a) iner.
    if ffmpeg_available() {
        let out = run_with_retry(|| {
            vec![
                "-f".into(),
                "bestaudio/best".into(),
                "-x".into(),
                "--audio-format".into(),
                "mp3".into(),
                "--audio-quality".into(),
                "4".into(),
                "--no-playlist".into(),
                "--no-warnings".into(),
                "-o".into(),
                tpl.clone(),
                url.clone(),
            ]
        })
        .await?;
        if out.status.success() {
            if let Some(p) = find_cached(&dir, &pre) {
                return Ok(p.to_string_lossy().to_string());
            }
        }
    }

    let out = run_with_retry(|| {
        vec![
            "-f".into(),
            "bestaudio[ext=m4a]/bestaudio".into(),
            "--no-playlist".into(),
            "--no-warnings".into(),
            "-o".into(),
            tpl.clone(),
            url.clone(),
        ]
    })
    .await?;
    match find_cached(&dir, &pre) {
        Some(p) => Ok(p.to_string_lossy().to_string()),
        None => Err(format!(
            "Orijinal ses indirilemedi: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("bilinmeyen hata")
        )),
    }
}

/// Sistemde ffmpeg çalışıyor mu? (PATH üzerinden; pencere açmadan)
fn ffmpeg_available() -> bool {
    let mut cmd = std::process::Command::new("ffmpeg");
    cmd.arg("-version").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// Önbellekteki ses dosyasının ham baytlarını (JSON yerine ikili olarak) döndürür.
#[tauri::command]
pub async fn read_audio(path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    if !p.starts_with(media_dir()) {
        return Err("Geçersiz ses yolu".into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Ses okunamadı: {e}"))?;
    Ok(Response::new(bytes))
}

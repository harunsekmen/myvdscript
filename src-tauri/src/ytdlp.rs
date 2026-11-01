use crate::store;
use std::{fs, path::PathBuf, process::Output, sync::OnceLock};
use tauri::{AppHandle, Emitter};

/// Olay yayınlamak için uygulama tutamacı (setup'ta atanır).
pub static APP: OnceLock<AppHandle> = OnceLock::new();

/// Ön yüze "ytdlp-status" olayıyla kısa bir durum metni gönderir (ör. yeniden deneme bilgisi).
pub fn status(msg: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("ytdlp-status", msg);
    }
}

// yt-dlp exe'nin içine gömülür; ilk kullanımda veri klasörüne açılır (tek dosyalık taşınabilir exe).
static YTDLP: &[u8] = include_bytes!("../binaries/yt-dlp-x86_64-pc-windows-msvc.exe");

fn ensure() -> Result<PathBuf, String> {
    let dir = store::root().join("bin");
    let path = dir.join("yt-dlp.exe");
    let ok = fs::metadata(&path).map(|m| m.len() == YTDLP.len() as u64).unwrap_or(false);
    if !ok {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        store::write_atomic(&path, YTDLP).map_err(|e| format!("yt-dlp açılamadı: {e}"))?;
    }
    Ok(path)
}

/// Ayarlardaki "cookiesBrowser" değerini okur; yt-dlp'ye tarayıcı çerezlerini kullandırır.
/// Yalnızca bilinen tarayıcılar kabul edilir.
fn cookie_args() -> Vec<String> {
    let browser = fs::read_to_string(store::settings_path())
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["cookiesBrowser"].as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default();
    match browser.as_str() {
        "firefox" => vec!["--cookies-from-browser".into(), browser],
        _ => vec![],
    }
}

pub async fn run(args: Vec<String>) -> Result<Output, String> {
    let path = ensure()?;
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(cookie_args());
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.output().await.map_err(|e| format!("yt-dlp çalıştırılamadı: {e}"))
}

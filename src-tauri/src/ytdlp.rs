use crate::store;
use std::{fs, path::PathBuf, process::Output};

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

pub async fn run(args: Vec<String>) -> Result<Output, String> {
    let path = ensure()?;
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.output().await.map_err(|e| format!("yt-dlp çalıştırılamadı: {e}"))
}

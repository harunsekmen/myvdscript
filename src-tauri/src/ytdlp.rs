use crate::store;
use std::{fs, process::Output, sync::OnceLock};
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
#[cfg(windows)]
static YTDLP: &[u8] = include_bytes!("../binaries/yt-dlp-x86_64-pc-windows-msvc.exe");

#[cfg(windows)]
fn executable() -> Result<std::path::PathBuf, String> {
    let dir = store::root().join("bin");
    let path = dir.join("yt-dlp.exe");
    let ok = fs::metadata(&path).map(|m| m.len() == YTDLP.len() as u64).unwrap_or(false);
    if !ok {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        store::write_atomic(&path, YTDLP).map_err(|e| format!("yt-dlp açılamadı: {e}"))?;
    }
    Ok(path)
}

#[cfg(not(windows))]
fn executable() -> Result<std::path::PathBuf, String> {
    Ok("yt-dlp".into())
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

fn command(args: Vec<String>) -> Result<tokio::process::Command, String> {
    let mut cmd = tokio::process::Command::new(executable()?);
    #[cfg(target_os = "macos")]
    crate::mac_tools::set_tool_path(&mut cmd);
    cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    cmd.args(["--encoding", "utf-8"]);
    cmd.args(cookie_args());
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok(cmd)
}

fn launch_error(err: std::io::Error) -> String {
    #[cfg(target_os = "macos")]
    if err.kind() == std::io::ErrorKind::NotFound {
        return "yt-dlp bulunamadı. Homebrew ile yt-dlp ve Deno kurup yeniden deneyin.".into();
    }
    format!("yt-dlp çalıştırılamadı: {err}")
}

pub async fn run(args: Vec<String>) -> Result<Output, String> {
    command(args)?.output().await.map_err(launch_error)
}

/// yt-dlp'yi çalıştırır ve stdout'un her satırını geldiği anda `on_line`'a verir.
/// Dönüş: (başarılı mı, stderr).
pub async fn run_lines(args: Vec<String>, mut on_line: impl FnMut(&str)) -> Result<(bool, String), String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let mut cmd = command(args)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(launch_error)?;
    let stdout = child.stdout.take().ok_or("yt-dlp çıktısı alınamadı")?;
    let mut stderr = child.stderr.take().ok_or("yt-dlp çıktısı alınamadı")?;
    let err_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).to_string()
    });
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        on_line(&String::from_utf8_lossy(&buf));
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok((status.success(), err_task.await.unwrap_or_default()))
}

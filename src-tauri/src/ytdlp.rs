#[cfg(any(windows, target_os = "macos"))]
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
    let ok = fs::metadata(&path)
        .map(|m| m.len() == YTDLP.len() as u64)
        .unwrap_or(false);
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

fn firefox_args(profile: &str) -> Result<Vec<String>, String> {
    let profile = profile.trim();
    let spec = if profile.is_empty() {
        "firefox".into()
    } else {
        let path = std::path::Path::new(profile);
        if !path.is_absolute() || profile.contains("::") {
            return Err("Firefox profilinin tam klasör yolunu seçin.".into());
        }
        let db = path.join("cookies.sqlite");
        fs::File::open(db).map_err(|error| profile_error(&error))?;
        format!("firefox:{profile}")
    };
    Ok(vec!["--cookies-from-browser".into(), spec])
}

fn profile_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "Firefox profiline erişim izni yok. Ayarlar › Ses ve YouTube’dan erişilebilir bir profil seçin.".into(),
        std::io::ErrorKind::NotFound => "Seçilen Firefox profilinde cookies.sqlite yok. Firefox’ta bu profille YouTube’u bir kez açın.".into(),
        _ => "Firefox çerez veritabanı açılamadı.".into(),
    }
}

fn cookie_args() -> Result<Vec<String>, String> {
    let settings = crate::commands::settings::load_settings();
    match settings["cookiesBrowser"].as_str().map(str::trim) {
        Some("firefox") => {
            firefox_args(settings["firefoxProfilePath"].as_str().unwrap_or_default())
        }
        _ => Ok(vec![]),
    }
}

fn command(args: Vec<String>, cookies: Vec<String>) -> Result<tokio::process::Command, String> {
    let mut cmd = tokio::process::Command::new(executable()?);
    #[cfg(target_os = "macos")]
    crate::mac_tools::set_tool_path(&mut cmd);
    cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");
    cmd.args(["--encoding", "utf-8"]);
    cmd.args(cookies);
    cmd.args(args);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok(cmd)
}

/// yt-dlp otomatik profil keşfinde macOS erişim reddini "veritabanı bulunamadı" diye bildirir.
fn firefox_diagnostic(stderr: &str) -> Option<String> {
    if stderr.contains("could not find firefox cookies database") {
        let detail = if cfg!(target_os = "macos") {
            "Firefox’un varsayılan profili okunamadı. Ayarlar › Ses ve YouTube’dan “Ayrı Firefox profili aç” seçeneğini kullanın veya erişilebilir bir profil seçin."
        } else {
            "Firefox çerez veritabanı bulunamadı. Ayarlar › Ses ve YouTube’dan kullanılan Firefox profilini seçin."
        };
        Some(detail.into())
    } else if stderr.contains("cookies.sqlite")
        && (stderr.contains("Operation not permitted") || stderr.contains("Permission denied"))
    {
        Some(profile_error(&std::io::ErrorKind::PermissionDenied.into()))
    } else {
        None
    }
}

fn extracted_count(stdout: &str) -> Option<u32> {
    stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Extracted ")?
            .strip_suffix(" cookies from firefox")?
            .parse()
            .ok()
    })
}

#[tauri::command]
pub async fn test_firefox_cookies(profile: String) -> Result<u32, String> {
    let cookies = firefox_args(&profile)?;
    let period = std::time::Duration::from_secs(15);
    // Bir bilgi dosyasını simüle etmek tarayıcı okumasını tetikler. Video veya ağ isteği oluşturmaz.
    let info = std::env::temp_dir().join(format!(
        "sa-firefox-check-{}.json",
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&info, br#"{"id":"firefox-check","title":"Firefox check","ext":"mp4","url":"https://localhost.invalid/probe.mp4"}"#)
        .map_err(|_| "Firefox denetimi başlatılamadı")?;
    let out = async {
        let mut cmd = command(
            vec![
                "--ignore-config".into(),
                "--no-progress".into(),
                "--simulate".into(),
                "--load-info-json".into(),
                info.to_string_lossy().into_owned(),
            ],
            cookies,
        )?;
        tokio::time::timeout(period, cmd.output())
            .await
            .map_err(|_| "Firefox çerez testi zaman aşımına uğradı".to_string())?
            .map_err(launch_error)
    }
    .await;
    let _ = fs::remove_file(&info);
    let out = out?;
    if !out.status.success() {
        return Err(firefox_diagnostic(&String::from_utf8_lossy(&out.stderr))
            .unwrap_or_else(|| "yt-dlp Firefox çerezlerini okuyamadı.".into()));
    }
    extracted_count(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "yt-dlp çerez sayısını bildirmedi.".into())
}

#[tauri::command]
pub async fn open_firefox_profile() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::DirBuilderExt;
        let profile = store::root().join("firefox-youtube-profile");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&profile)
            .map_err(|_| "Firefox profil klasörü oluşturulamadı")?;
        let opened = tokio::process::Command::new("/usr/bin/open")
            .args(["-n", "-a", "Firefox", "--args", "--profile"])
            .arg(&profile)
            .args(["--new-instance", "-url", "https://www.youtube.com/"])
            .output()
            .await
            .map_err(|_| "Firefox açılamadı")?;
        if !opened.status.success() {
            return Err("Firefox açılamadı. Firefox’un kurulu olduğunu kontrol edin.".into());
        }
        Ok(profile.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Bu seçenek macOS’te kullanılabilir.".into())
    }
}

fn launch_error(err: std::io::Error) -> String {
    #[cfg(target_os = "macos")]
    if err.kind() == std::io::ErrorKind::NotFound {
        return "yt-dlp bulunamadı. Homebrew ile yt-dlp ve Deno kurup yeniden deneyin.".into();
    }
    format!("yt-dlp çalıştırılamadı: {err}")
}

pub async fn run(args: Vec<String>) -> Result<Output, String> {
    let cookies = cookie_args()?;
    let firefox = !cookies.is_empty();
    let out = command(args, cookies)?
        .output()
        .await
        .map_err(launch_error)?;
    if firefox && !out.status.success() {
        if let Some(error) = firefox_diagnostic(&String::from_utf8_lossy(&out.stderr)) {
            return Err(error);
        }
    }
    Ok(out)
}

/// yt-dlp'yi çalıştırır ve stdout'un her satırını geldiği anda `on_line`'a verir.
/// Dönüş: (başarılı mı, stderr).
pub async fn run_lines(
    args: Vec<String>,
    mut on_line: impl FnMut(&str),
) -> Result<(bool, String), String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let cookies = cookie_args()?;
    let firefox = !cookies.is_empty();
    let mut cmd = command(args, cookies)?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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
        let n = reader
            .read_until(b'\n', &mut buf)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        on_line(&String::from_utf8_lossy(&buf));
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    if firefox && !status.success() {
        if let Some(error) = firefox_diagnostic(&stderr) {
            return Err(error);
        }
    }
    Ok((status.success(), stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firefox_default_uses_discovery_and_an_explicit_profile_is_one_argument() {
        assert_eq!(
            firefox_args("").unwrap(),
            ["--cookies-from-browser", "firefox"]
        );
        assert!(firefox_args("relative").is_err());
        let profile =
            std::env::temp_dir().join(format!("firefox QA {}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&profile).unwrap();
        let path = profile.to_str().unwrap();
        assert!(firefox_args(path).unwrap_err().contains("cookies.sqlite"));
        fs::write(profile.join("cookies.sqlite"), b"fixture").unwrap();
        let args = firefox_args(path).unwrap();
        assert_eq!(args, ["--cookies-from-browser", &format!("firefox:{path}")]);
        fs::remove_dir_all(profile).unwrap();
    }

    #[test]
    fn firefox_output_reports_only_cookie_count_and_normalizes_access_errors() {
        assert_eq!(
            extracted_count("Extracting cookies from firefox\nExtracted 6 cookies from firefox\n"),
            Some(6)
        );
        assert_eq!(extracted_count("Extracted 0 cookies from firefox"), Some(0));
        let error = firefox_diagnostic(
            "ERROR: could not find firefox cookies database in '/some/private/path'",
        )
        .unwrap();
        assert!(!error.contains("/some/private/path"));
        assert!(firefox_diagnostic("HTTP Error 429: Too Many Requests").is_none());
    }
}

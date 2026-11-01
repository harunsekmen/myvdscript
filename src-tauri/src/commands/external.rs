/// Bağlantıyı sistemin varsayılan tarayıcısında açar (ör. YouTube videosu).
/// Yalnızca http/https bağlantılarına izin verilir.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Geçerli bir bağlantı değil".into());
    }
    // `start` yerine doğrudan açıcı kullanılır: URL'deki `&` karakteri kabuk tarafından bölünmez.
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawned.map(|_| ()).map_err(|e| format!("Bağlantı açılamadı: {e}"))
}

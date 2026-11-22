use serde_json::Value;
use tauri::AppHandle;

#[tauri::command]
pub fn automatic_update_supported() -> bool {
    #[cfg(windows)]
    {
        use tauri::utils::{config::BundleType, platform::bundle_type};
        matches!(bundle_type(), Some(BundleType::Nsis | BundleType::Msi))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub async fn check_manual_update(app: AppHandle) -> Result<Option<String>, String> {
    let release = crate::http::client()
        .get("https://api.github.com/repos/harunsekmen/myvdscript/releases/latest")
        .header("User-Agent", "ScriptAtolyesi")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|_| "GitHub Releases'e bağlanılamadı")?;
    if release.status().as_u16() == 404 {
        return Ok(None);
    }
    let value: Value = release
        .error_for_status()
        .map_err(|_| "GitHub Releases yanıt vermedi")?
        .json()
        .await
        .map_err(|_| "Sürüm bilgisi okunamadı")?;
    let tag = value["tag_name"]
        .as_str()
        .unwrap_or_default()
        .trim_start_matches('v');
    Ok(tag
        .parse()
        .ok()
        .filter(|v| app.package_info().version.lt(v))
        .map(|_| tag.to_string()))
}

use crate::store;
use serde_json::{json, Value};
use std::fs;

const SERVICE: &str = "ScriptAtolyesi";
const USER: &str = "api_key";
const GROQ_USER: &str = "groq_api_key";
const YOUTUBE_USER: &str = "youtube_api_key";

fn read_key(user: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, user).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

fn write_key(user: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, user).map_err(|e| e.to_string())?;
    if key.trim().is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

pub fn api_key() -> Option<String> {
    read_key(USER)
}

/// Groq (ses → yazı) anahtarı; AI anahtarından ayrı tutulur.
pub fn groq_key() -> Option<String> {
    read_key(GROQ_USER)
}

/// YouTube Data API v3 anahtarı (isteğe bağlı; ana sayfa istatistikleri için).
pub fn youtube_key() -> Option<String> {
    read_key(YOUTUBE_USER)
}

/// settings.json'dan tek bir metin ayarı (yoksa boş).
pub fn setting_str(key: &str) -> String {
    fs::read_to_string(store::settings_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v[key].as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn load_settings() -> Value {
    fs::read_to_string(store::settings_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
pub fn save_settings(settings: Value) -> Result<(), String> {
    let _guard = store::lock_data()?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    store::write_atomic(&store::settings_path(), &bytes)?;
    super::backups::daily_settings(&bytes);
    Ok(())
}

#[tauri::command]
pub fn has_api_key() -> bool {
    api_key().is_some()
}

#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    write_key(USER, &key)
}

#[tauri::command]
pub fn has_groq_key() -> bool {
    groq_key().is_some()
}

#[tauri::command]
pub fn set_groq_key(key: String) -> Result<(), String> {
    write_key(GROQ_USER, &key)
}

#[tauri::command]
pub fn has_youtube_key() -> bool {
    youtube_key().is_some()
}

#[tauri::command]
pub fn set_youtube_key(key: String) -> Result<(), String> {
    write_key(YOUTUBE_USER, &key)
}

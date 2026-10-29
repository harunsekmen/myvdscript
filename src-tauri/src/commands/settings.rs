use crate::store;
use serde_json::{json, Value};
use std::fs;

const SERVICE: &str = "ScriptAtolyesi";
const USER: &str = "api_key";

pub fn api_key() -> Option<String> {
    keyring::Entry::new(SERVICE, USER).ok()?.get_password().ok().filter(|k| !k.is_empty())
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
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    store::write_atomic(&store::settings_path(), &bytes)
}

#[tauri::command]
pub fn has_api_key() -> bool {
    api_key().is_some()
}

#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, USER).map_err(|e| e.to_string())?;
    if key.trim().is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

use super::{backups, projects, settings};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Instant};
use tauri::{AppHandle, Manager};

pub const LOG_NAME: &str = "script-atolyesi";

pub fn safe_model(model: &str) -> &str {
    let id = model.trim();
    if id.is_empty() {
        return "varsayılan";
    }
    // User-supplied model strings can contain keys or URL credentials. Only retain recognized model IDs.
    const MODELS: &[&str] = &[
        "gpt-6-luna",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.2-codex",
        "gpt-5.1-codex",
        "gpt-5",
        "gpt-4o",
        "gpt-4o-mini",
        "o3",
        "o4-mini",
        "qwen3:4b",
        "qwen3:8b",
        "qwen3-4b",
        "qwen3-8b",
        "local-model",
        "deepseek-chat",
        "deepseek-reasoner",
    ];
    if MODELS.contains(&id) {
        id
    } else {
        "özel"
    }
}

pub struct AiTrace<'a> {
    provider: &'static str,
    model: &'a str,
    chars: usize,
    started: Instant,
    completed: bool,
}

impl<'a> AiTrace<'a> {
    pub fn new(provider: &'static str, model: &'a str, chars: usize) -> Self {
        Self {
            provider,
            model: safe_model(model),
            chars,
            started: Instant::now(),
            completed: false,
        }
    }

    fn write(&self, status: &str, code: Option<i32>) {
        log::info!(
            target: "script_ai", "provider={} model={} chars={} ms={} status={} exit={}",
            self.provider, self.model, self.chars, self.started.elapsed().as_millis(), status,
            code.map_or_else(|| "none".to_string(), |n| n.to_string())
        );
    }

    pub fn finish(mut self, status: &'static str, code: Option<i32>) {
        self.write(status, code);
        self.completed = true;
    }
}

impl Drop for AiTrace<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.write("cancelled", None);
        }
    }
}

fn system_info(version: &str, data: &Value, projects: usize) -> Value {
    let provider = match data["aiProvider"].as_str() {
        Some("codex") => "codex",
        Some("api") => "api",
        _ => "default",
    };
    json!({
        "version": version,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "projectCount": projects,
        "provider": provider,
        "codexModel": safe_model(data["codexModel"].as_str().unwrap_or_default()),
        "apiModel": safe_model(data["model"].as_str().unwrap_or_default()),
        "codexApiFallback": data["codexApiFallback"].as_bool().unwrap_or(false),
        "codexTimeoutSec": data["codexTimeoutSec"].as_u64(),
        "publishWpm": data["publishWpm"].as_u64(),
    })
}

fn clean_project_meta(project: &Value) -> Value {
    json!({
        "createdAt": project["createdAt"].as_u64(),
        "updatedAt": project["updatedAt"].as_u64(),
        "sourceCount": project["sources"].as_array().map_or(0, Vec::len),
        "archived": project["archived"].as_bool().unwrap_or(false),
    })
}

#[tauri::command]
pub async fn export_diagnostics(app: AppHandle, path: String) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let version = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = crate::store::lock_data()?;
        let projects = projects::list_projects()?;
        let meta: Vec<_> = projects.iter().map(clean_project_meta).collect();
        let data = settings::load_settings();
        let bytes = |value| serde_json::to_vec_pretty(value).map_err(|e| e.to_string());
        let mut files = vec![
            (
                "system.json".into(),
                bytes(&system_info(&version, &data, projects.len()))?,
            ),
            (
                "projects-meta.json".into(),
                serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
            ),
        ];
        if let Ok(entries) = fs::read_dir(log_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !entry.file_type().is_ok_and(|file| file.is_file())
                    || !name.starts_with(LOG_NAME)
                    || !name.ends_with(".log")
                {
                    continue;
                }
                // The dedicated log file only receives our fixed metadata targets. Keep its size bounded here too.
                if entry
                    .metadata()
                    .is_ok_and(|metadata| metadata.len() <= 6 * 1024 * 1024)
                {
                    let contents = fs::read(entry.path()).map_err(|e| e.to_string())?;
                    files.push((format!("logs/{name}"), contents));
                }
            }
        }
        backups::write_diagnostics(Path::new(&path), &files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_keep_metadata_and_drop_raw_settings_and_titles() {
        let secret = "audit-test-secret";
        let settings = json!({
            "aiProvider": "codex", "codexModel": "gpt-6-luna",
            "model": secret, "baseUrl": secret, "codexPath": secret, "systemPrompt": secret, "apiKey": secret,
        });
        let project = json!({ "id": secret, "title": secret, "url": secret, "sources": [{ "url": secret }], "updatedAt": 12 });
        let values = json!([
            system_info("0.2.0", &settings, 1),
            clean_project_meta(&project)
        ]);
        assert!(!values.to_string().contains(secret));
        assert_eq!(values[0]["codexModel"], "gpt-6-luna");
        assert_eq!(values[1]["sourceCount"], 1);
    }
}

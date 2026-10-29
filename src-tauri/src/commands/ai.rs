use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State};

use super::settings::api_key;

#[derive(Default)]
pub struct AiState(Mutex<HashMap<String, JoinHandle<()>>>);

#[derive(Serialize, Clone)]
struct AiEvent {
    kind: &'static str, // delta | done | error
    text: String,
}

fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim().trim_end_matches('/'), path)
}

fn with_auth(rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match api_key() {
        Some(k) => rb.bearer_auth(k),
        None => rb,
    }
}

#[tauri::command]
pub async fn list_models(base_url: String) -> Result<Vec<String>, String> {
    let resp = with_auth(reqwest::Client::new().get(endpoint(&base_url, "models")))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Bağlanılamadı: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("Yanıt okunamadı: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", v["error"]["message"].as_str().unwrap_or("hata")));
    }
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .or_else(|| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().or_else(|| m.as_str()).map(String::from))
        .collect();
    ids.sort();
    Ok(ids)
}

/// Çıktıyı `ai://<request_id>` olayı olarak akıtır.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_stream(
    app: AppHandle,
    state: State<'_, AiState>,
    request_id: String,
    base_url: String,
    model: String,
    system: String,
    user: String,
    temperature: f64,
) {
    let event = format!("ai://{request_id}");
    let rid = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        match run_stream(&app, &event, &base_url, &model, &system, &user, temperature).await {
            Ok(()) => {
                let _ = app.emit(&event, AiEvent { kind: "done", text: String::new() });
            }
            Err(e) => {
                let _ = app.emit(&event, AiEvent { kind: "error", text: e });
            }
        }
        if let Some(st) = app.try_state::<AiState>() {
            st.0.lock().unwrap().remove(&rid);
        }
    });
    state.0.lock().unwrap().insert(request_id, handle);
}

async fn run_stream(
    app: &AppHandle,
    event: &str,
    base_url: &str,
    model: &str,
    system: &str,
    user: &str,
    temperature: f64,
) -> Result<(), String> {
    let body = json!({
        "model": model,
        "stream": true,
        "temperature": temperature,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let resp = with_auth(reqwest::Client::new().post(endpoint(base_url, "chat/completions")))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Bağlanılamadı: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&t)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(t);
        return Err(format!("HTTP {status}: {}", msg.chars().take(300).collect::<String>()));
    }
    let is_sse = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|c| c.contains("event-stream"))
        .unwrap_or(false);

    let emit = |text: String| {
        let _ = app.emit(event, AiEvent { kind: "delta", text });
    };

    if !is_sse {
        // Akış desteklemeyen sunucu: tek parça yanıt.
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        emit(v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string());
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = vec![];
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| format!("Akış kesildi: {e}"))?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = v["error"]["message"].as_str() {
                return Err(err.to_string());
            }
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                if !t.is_empty() {
                    emit(t.to_string());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, request_id: String) {
    if let Some(h) = state.0.lock().unwrap().remove(&request_id) {
        h.abort();
    }
}

use super::settings::groq_key;
use reqwest::multipart;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const ENDPOINT: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL: &str = "whisper-large-v3";

/// Groq'un kabul ettiği ses/video biçimleri.
const FORMATS: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("mpga", "audio/mpeg"),
    ("mpeg", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("mp4", "video/mp4"),
    ("wav", "audio/wav"),
    ("flac", "audio/flac"),
    ("ogg", "audio/ogg"),
    ("webm", "video/webm"),
];

/// Seçilen ses/videoyu Groq Whisper'a gönderir; kelime kelime zaman damgalarını döndürür.
/// Dönüş: { language, duration, text, words: [{ word, start, end }] }
#[tauri::command]
pub async fn transcribe_media(path: String, language: String) -> Result<Value, String> {
    let key = groq_key().ok_or("Groq API anahtarı girilmemiş (Ayarlar'dan ekleyin)")?;
    let file = Path::new(&path);
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = FORMATS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
        .ok_or_else(|| format!("Bu biçim desteklenmiyor (.{ext}). Desteklenenler: mp3, mp4, m4a, wav, webm, ogg, flac"))?;
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("medya").to_string();

    let bytes = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || std::fs::read(path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Dosya okunamadı: {e}"))?;

    let part = multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str(mime)
        .map_err(|e| e.to_string())?;
    let mut form = multipart::Form::new()
        .part("file", part)
        .text("model", MODEL)
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "word");
    let lang = language.trim();
    if !lang.is_empty() {
        form = form.text("language", lang.to_string());
    }

    let resp = crate::http::client()
        .post(ENDPOINT)
        .bearer_auth(key)
        .multipart(form)
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(|e| format!("Groq'a bağlanılamadı: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Yanıt okunamadı: {e}"))?;
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(text);
        return Err(format!("Groq HTTP {status}: {}", msg.chars().take(300).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Yanıt çözülemedi: {e}"))?;
    let words: Vec<Value> = v["words"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|w| {
                    Some(json!({
                        "word": w["word"].as_str()?,
                        "start": w["start"].as_f64()?,
                        "end": w["end"].as_f64()?,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "language": v["language"].as_str().unwrap_or(""),
        "duration": v["duration"].as_f64().unwrap_or(0.0),
        "text": v["text"].as_str().unwrap_or(""),
        "words": words,
    }))
}

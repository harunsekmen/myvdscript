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

/// Doğrudan gönderilen ses biçimleri; bunların dışındaki her şey (videolar dahil) önce ffmpeg ile mp3'e çevrilir.
const AUDIO_DIRECT: &[&str] = &["mp3", "mpga", "mpeg", "m4a", "wav", "flac", "ogg"];
/// Groq'un dosya sınırının (25 MB) biraz altı: daha büyük ses dosyaları da sıkıştırılır.
const MAX_DIRECT_BYTES: u64 = 24 * 1024 * 1024;

/// Video (ya da desteklenmeyen/büyük ses) dosyasını ffmpeg ile tek kanallı, konuşmaya yeterli mp3'e çevirir.
/// 16 kHz · 48 kbps ≈ saatte 21 MB.
async fn to_mp3(src: &Path) -> Result<std::path::PathBuf, String> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let out = std::env::temp_dir().join(format!("script-atolyesi-{}-{stamp}.mp3", std::process::id()));
    let mut cmd = tokio::process::Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3"])
        .arg(&out);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let res = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "ffmpeg bulunamadı. Videoları sese çevirmek için ffmpeg kurun (ör. `winget install ffmpeg`) ve uygulamayı yeniden başlatın".to_string()
        } else {
            format!("ffmpeg çalıştırılamadı: {e}")
        }
    })?;
    if !res.status.success() {
        let _ = std::fs::remove_file(&out);
        let err = String::from_utf8_lossy(&res.stderr);
        let err = err.trim();
        if err.contains("matches no streams") || err.contains("does not contain any stream") {
            return Err("Dosyada ses kanalı yok".into());
        }
        return Err(format!("ffmpeg sese çeviremedi: {}", err.chars().take(300).collect::<String>()));
    }
    Ok(out)
}

/// ffmpeg: önce exe'nin yanındaki ffmpeg.exe, yoksa PATH.
pub fn ffmpeg_path() -> std::path::PathBuf {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(local) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(exe))) {
        if local.is_file() {
            return local;
        }
    }
    std::path::PathBuf::from(exe)
}

/// Seçilen ses/videoyu Groq Whisper'a gönderir; kelime kelime zaman damgalarını döndürür.
/// Video ya da doğrudan gönderilemeyen ses dosyaları önce ffmpeg ile mp3'e çevrilir.
/// Dönüş: { language, duration, text, words: [{ word, start, end }] }
#[tauri::command]
pub async fn transcribe_media(path: String, language: String) -> Result<Value, String> {
    let key = groq_key().ok_or("Groq API anahtarı girilmemiş (Ayarlar'dan ekleyin)")?;
    let file = Path::new(&path);
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let size = std::fs::metadata(file).map_err(|e| format!("Dosya okunamadı: {e}"))?.len();
    let stem = file.file_stem().and_then(|n| n.to_str()).unwrap_or("medya").to_string();

    let converted = if AUDIO_DIRECT.contains(&ext.as_str()) && size <= MAX_DIRECT_BYTES {
        None
    } else {
        Some(to_mp3(file).await?)
    };
    let (send_path, name, mime) = match &converted {
        Some(p) => (p.clone(), format!("{stem}.mp3"), "audio/mpeg"),
        None => {
            let mime = FORMATS.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).unwrap_or("audio/mpeg");
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("medya").to_string();
            (file.to_path_buf(), name, mime)
        }
    };

    let read = tauri::async_runtime::spawn_blocking({
        let p = send_path.clone();
        move || std::fs::read(p)
    })
    .await
    .map_err(|e| e.to_string());
    if let Some(p) = &converted {
        let _ = std::fs::remove_file(p);
    }
    let bytes = read?.map_err(|e| format!("Dosya okunamadı: {e}"))?;
    if bytes.len() as u64 > 25 * 1024 * 1024 {
        return Err("Ses dosyası çok büyük (Groq sınırı 25 MB; yaklaşık 70 dakikadan uzun kayıtları bölün)".into());
    }

    groq_transcribe(&key, bytes, name, mime, &language).await
}

/// Ses baytlarını Groq Whisper'a gönderir ve kelime zamanlı sonucu sadeleştirir.
pub async fn groq_transcribe(key: &str, bytes: Vec<u8>, name: String, mime: &str, language: &str) -> Result<Value, String> {
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

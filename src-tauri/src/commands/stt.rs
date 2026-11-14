use super::settings::groq_key;
use super::whisper;
use reqwest::multipart;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::ipc::{InvokeBody, Request};
use tauri::AppHandle;

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

/// Geçici dosya yolu (ASCII ad; dış araçlar Unicode yollarda sorun çıkarabiliyor).
pub fn temp_path(ext: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::env::temp_dir().join(format!("script-atolyesi-{}-{stamp}.{ext}", std::process::id()))
}

/// Video (ya da desteklenmeyen/büyük ses) dosyasını ffmpeg ile tek kanallı, konuşmaya yeterli mp3'e çevirir.
/// 16 kHz · 48 kbps ≈ saatte 21 MB.
async fn to_mp3(src: &Path) -> Result<std::path::PathBuf, String> {
    ffmpeg_convert(src, false).await
}

/// Yerel Whisper için 16 kHz, tek kanallı 16 bit WAV.
async fn to_wav16(src: &Path) -> Result<std::path::PathBuf, String> {
    ffmpeg_convert(src, true).await
}

async fn ffmpeg_convert(src: &Path, wav: bool) -> Result<std::path::PathBuf, String> {
    let out = temp_path(if wav { "wav" } else { "mp3" });
    let codec: &[&str] = if wav { &["-c:a", "pcm_s16le", "-f", "wav"] } else { &["-b:a", "48k", "-f", "mp3"] };
    let mut cmd = tokio::process::Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000"])
        .args(codec)
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

/// Seçilen ses/videoyu yazıya çevirir; kelime kelime zaman damgalarını döndürür.
/// `engine`: "groq" (varsayılan) ya da "local" (yerel Whisper, `model` ile).
/// Groq: video ya da doğrudan gönderilemeyen ses dosyaları önce ffmpeg ile mp3'e çevrilir.
/// Yerel: her dosya ffmpeg ile 16 kHz WAV'a çevrilir.
/// Dönüş: { language, duration, text, words: [{ word, start, end }] }
#[tauri::command]
pub async fn transcribe_media(
    app: AppHandle,
    path: String,
    language: String,
    engine: Option<String>,
    model: Option<String>,
    job: Option<String>,
    gpu: Option<bool>,
) -> Result<Value, String> {
    let file = Path::new(&path);
    if engine.as_deref() == Some("local") {
        let model = model.unwrap_or_default();
        whisper::ready(&model)?;
        let wav = to_wav16(file).await?;
        let res = whisper::transcribe(&app, &wav, &language, &model, job.as_deref().unwrap_or(""), gpu.unwrap_or(true)).await;
        let _ = std::fs::remove_file(&wav);
        return res;
    }

    let key = groq_key().ok_or("Groq API anahtarı girilmemiş (Ayarlar'dan ekleyin)")?;
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

fn header<'a>(req: &'a Request<'_>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Ön yüzde birleştirilmiş 16 kHz WAV'ı (ham gövde) yazıya çevirir. Başlıklar: `x-language`, `x-engine`
/// ("groq" | "local"), `x-model` (yerel model), `x-job` (yerel ilerleme olaylarının iş kimliği), `x-gpu` ("0" ise ekran kartı kullanılmaz). Ses kayıtları parça parça değil, birkaç parça bir arada
/// gönderilir; zamanlar bu birleşik sese göredir.
#[tauri::command]
pub async fn transcribe_audio(app: AppHandle, request: Request<'_>) -> Result<Value, String> {
    let language = header(&request, "x-language").unwrap_or("").to_string();
    let engine = header(&request, "x-engine").unwrap_or("groq").to_string();
    let model = header(&request, "x-model").unwrap_or("").to_string();
    let job = header(&request, "x-job").unwrap_or("").to_string();
    let gpu = header(&request, "x-gpu") != Some("0");
    let bytes = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => return Err("Ham ses verisi bekleniyordu".into()),
    };
    if bytes.len() < 44 {
        return Err("Ses boş".into());
    }

    if engine == "local" {
        whisper::ready(&model)?;
        let wav = temp_path("wav");
        std::fs::write(&wav, &bytes).map_err(|e| format!("Geçici dosya yazılamadı: {e}"))?;
        let res = whisper::transcribe(&app, &wav, &language, &model, &job, gpu).await;
        let _ = std::fs::remove_file(&wav);
        return res;
    }

    let key = groq_key().ok_or("Groq API anahtarı girilmemiş (Ayarlar'dan ekleyin)")?;
    // ffmpeg varsa küçük mp3 olarak gönder (daha hızlı yükleme); yoksa WAV olduğu gibi.
    let wav = temp_path("wav");
    std::fs::write(&wav, &bytes).map_err(|e| format!("Geçici dosya yazılamadı: {e}"))?;
    let mp3 = to_mp3(&wav).await;
    let _ = std::fs::remove_file(&wav);
    let (send, name, mime) = match mp3 {
        Ok(p) => {
            let b = std::fs::read(&p).map_err(|e| format!("Dosya okunamadı: {e}"));
            let _ = std::fs::remove_file(&p);
            (b?, "kayit.mp3".to_string(), "audio/mpeg")
        }
        Err(_) => (bytes, "kayit.wav".to_string(), "audio/wav"),
    };
    if send.len() > 25 * 1024 * 1024 {
        return Err("Ses çok büyük (Groq sınırı 25 MB)".into());
    }
    groq_transcribe(&key, send, name, mime, &language).await
}

/// Groq'un "try again in 3s" / "1m2.5s" / "750ms" önerisini saniyeye çevirir.
fn retry_after(msg: &str) -> Option<f64> {
    let re = regex::Regex::new(r"try again in ((?:\d+m)?[\d.]+(?:ms|s))").ok()?;
    let v = re.captures(msg)?.get(1)?.as_str();
    let total = if let Some(ms) = v.strip_suffix("ms") {
        ms.parse::<f64>().ok()? / 1000.0
    } else {
        let v = v.strip_suffix('s')?;
        let (m, s) = v.split_once('m').unwrap_or(("0", v));
        m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?
    };
    (total > 0.0).then_some(total)
}

/// Ses baytlarını Groq Whisper'a gönderir ve kelime zamanlı sonucu sadeleştirir.
/// İstek sınırına (HTTP 429) takılırsa önerilen süre kadar bekleyip birkaç kez yeniden dener.
pub async fn groq_transcribe(key: &str, bytes: Vec<u8>, name: String, mime: &str, language: &str) -> Result<Value, String> {
    let mut attempt = 0;
    let text = loop {
        attempt += 1;
        let part = multipart::Part::bytes(bytes.clone())
            .file_name(name.clone())
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
        let header_wait = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<f64>().ok());
        let text = resp.text().await.map_err(|e| format!("Yanıt okunamadı: {e}"))?;
        if status.is_success() {
            break text;
        }
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or(text);
        if status.as_u16() == 429 && attempt < 4 {
            let wait = header_wait.or_else(|| retry_after(&msg)).unwrap_or(5.0);
            if wait <= 90.0 {
                tokio::time::sleep(Duration::from_secs_f64(wait + 0.5)).await;
                continue;
            }
        }
        return Err(format!("Groq HTTP {status}: {}", msg.chars().take(300).collect::<String>()));
    };
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

#[cfg(test)]
mod tests {
    use super::retry_after;

    #[test]
    fn parses_groq_retry_hint() {
        assert_eq!(retry_after("Please try again in 3s. Need more"), Some(3.0));
        assert_eq!(retry_after("Please try again in 1m2.5s."), Some(62.5));
        assert_eq!(retry_after("Please try again in 750ms."), Some(0.75));
        assert_eq!(retry_after("Limit reached"), None);
    }
}

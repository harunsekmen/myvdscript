//! Senaryo için parça parça ses kayıtları: proje klasöründeki `voice/` altında saklanır.
//! Ses baytları IPC'de ham gövde olarak taşınır (base64 şişmesi olmadan).

use super::stt::ffmpeg_path;
use crate::store;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::ipc::{InvokeBody, Request, Response};

/// Kayıt dosyası adı yalnızca harf/rakam/-/_ ve tek uzantı içerebilir (klasör dışına çıkılamaz).
fn valid_file(name: &str) -> bool {
    let mut parts = name.splitn(2, '.');
    let stem = parts.next().unwrap_or("");
    let ext = parts.next().unwrap_or("");
    !stem.is_empty()
        && stem.len() <= 80
        && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && matches!(ext, "webm" | "ogg" | "wav" | "mp4" | "m4a")
}

fn voice_dir(project_id: &str) -> Result<PathBuf, String> {
    Ok(store::project_dir(project_id)?.join("voice"))
}

fn take_path(project_id: &str, file: &str) -> Result<PathBuf, String> {
    if !valid_file(file) {
        return Err("Geçersiz kayıt dosyası adı".into());
    }
    Ok(voice_dir(project_id)?.join(file))
}

fn header<'a>(req: &'a Request<'_>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// `%XX` kodlamasını çözer (başlıklarda ASCII dışı yol taşımak için).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn raw_body(req: &Request<'_>) -> Result<Vec<u8>, String> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        InvokeBody::Json(_) => Err("Ham ses verisi bekleniyordu".into()),
    }
}

/// Yeni kaydı yazar. Başlıklar: `x-project` (proje kimliği), `x-ext` (webm/ogg/wav/mp4).
/// Dönüş: { file }
#[tauri::command]
pub fn save_voice_take(request: Request<'_>) -> Result<Value, String> {
    let project = header(&request, "x-project").ok_or("Proje kimliği eksik")?.to_string();
    let ext = match header(&request, "x-ext").unwrap_or("webm") {
        e @ ("webm" | "ogg" | "wav" | "mp4" | "m4a") => e.to_string(),
        _ => "webm".to_string(),
    };
    let bytes = raw_body(&request)?;
    if bytes.is_empty() {
        return Err("Kayıt boş".into());
    }
    // Proje silinmişse (kayıt sürerken silinen proje) klasörü yeniden yaratma.
    if !store::project_dir(&project)?.join("project.json").is_file() {
        return Err("Proje bulunamadı (silinmiş olabilir)".into());
    }
    let dir = voice_dir(&project)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = format!("kayit-{}.{ext}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    store::write_atomic(&dir.join(&file), &bytes)?;
    Ok(json!({ "file": file }))
}

/// Kaydın baytlarını ham yanıt olarak döndürür (ön yüzde ArrayBuffer olarak gelir).
#[tauri::command]
pub fn read_voice_take(project_id: String, file: String) -> Result<Response, String> {
    let p = take_path(&project_id, &file)?;
    let bytes = fs::read(&p).map_err(|e| format!("Kayıt okunamadı: {e}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn delete_voice_take(project_id: String, file: String) -> Result<(), String> {
    let p = take_path(&project_id, &file)?;
    if p.is_file() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Projenin `voice/` klasöründe, listede olmayan (silinmiş/yeniden kaydedilmiş) dosyaları temizler.
#[tauri::command]
pub fn prune_voice_takes(project_id: String, keep: Vec<String>) -> Result<u32, String> {
    let dir = voice_dir(&project_id)?;
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(0) };
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if valid_file(&name) && !keep.contains(&name) && e.path().is_file() && fs::remove_file(e.path()).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Çıkış uzantısına göre ffmpeg kodlayıcı ayarları.
fn codec_args(ext: &str) -> Option<&'static [&'static str]> {
    Some(match ext {
        "mp3" => &["-c:a", "libmp3lame", "-b:a", "192k"],
        "m4a" | "aac" => &["-c:a", "aac", "-b:a", "192k"],
        "wav" => &["-c:a", "pcm_s16le"],
        "flac" => &["-c:a", "flac"],
        "ogg" | "opus" => &["-c:a", "libopus", "-b:a", "128k"],
        _ => return None,
    })
}

/// Kayıtları sırayla, aralarına `gap_ms` sessizlik koyarak tek dosyada birleştirir (ffmpeg gerekir).
/// Uzantı biçimi belirler: mp3, m4a, wav, flac, ogg.
#[tauri::command]
pub async fn export_voice_takes(project_id: String, files: Vec<String>, gap_ms: u32, out_path: String) -> Result<(), String> {
    if files.is_empty() {
        return Err("Birleştirilecek kayıt yok".into());
    }
    let out = PathBuf::from(&out_path);
    if out_path.trim().is_empty() || out.is_dir() {
        return Err("Geçersiz dosya yolu".into());
    }
    let ext = out.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let codec = codec_args(&ext).ok_or("Desteklenmeyen biçim (mp3, m4a, wav, flac, ogg)")?;
    let inputs: Vec<PathBuf> = files.iter().map(|f| take_path(&project_id, f)).collect::<Result<_, _>>()?;
    for p in &inputs {
        if !p.is_file() {
            return Err(format!("Kayıt dosyası bulunamadı: {}", p.display()));
        }
    }
    let gap = gap_ms as f64 / 1000.0;
    let n = inputs.len();
    let mut filter = String::new();
    for i in 0..n {
        filter.push_str(&format!("[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono"));
        if i + 1 < n && gap > 0.0 {
            filter.push_str(&format!(",apad=pad_dur={gap:.3}"));
        }
        filter.push_str(&format!("[a{i}];"));
    }
    for i in 0..n {
        filter.push_str(&format!("[a{i}]"));
    }
    filter.push_str(&format!("concat=n={n}:v=0:a=1[out]"));

    let mut cmd = tokio::process::Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    for p in &inputs {
        cmd.arg("-i").arg(p);
    }
    cmd.args(["-filter_complex", &filter, "-map", "[out]"]).args(codec).arg(&out);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let res = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "NO_FFMPEG".to_string()
        } else {
            format!("ffmpeg çalıştırılamadı: {e}")
        }
    })?;
    if !res.status.success() {
        let err = String::from_utf8_lossy(&res.stderr);
        return Err(format!("ffmpeg birleştiremedi: {}", err.trim().chars().take(300).collect::<String>()));
    }
    Ok(())
}

/// Ön yüzde üretilen ikili dosyayı (ör. WAV) kullanıcının seçtiği yola yazar.
/// Başlık: `x-path` (yüzde kodlu tam yol).
#[tauri::command]
pub fn save_binary_file(request: Request<'_>) -> Result<(), String> {
    let path = percent_decode(header(&request, "x-path").ok_or("Dosya yolu eksik")?);
    let p = Path::new(&path);
    if path.trim().is_empty() || p.is_dir() {
        return Err("Geçersiz dosya yolu".into());
    }
    let bytes = raw_body(&request)?;
    fs::write(p, bytes).map_err(|e| format!("Dosya yazılamadı: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_restricted() {
        assert!(valid_file("kayit-abc123.webm"));
        assert!(!valid_file("../x.webm"));
        assert!(!valid_file("a/b.webm"));
        assert!(!valid_file("x.exe"));
        assert!(!valid_file("x.webm.exe"));
        assert!(!valid_file(".webm"));
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("C%3A%5CKay%C4%B1t%20%C3%96.wav"), "C:\\Kayıt Ö.wav");
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("100%25"), "100%");
    }
}

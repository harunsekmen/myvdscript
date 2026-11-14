//! Yerel ses → yazı: whisper.cpp (`whisper-cli.exe`) ve ggml modelleri uygulama klasörüne indirilir,
//! çeviri internete çıkmadan bu bilgisayarda yapılır. Dönüş biçimi Groq ile aynıdır:
//! { language, duration, text, words: [{ word, start, end }] }

use crate::store;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

/// Sabit sürüm: en son sürüm sayfası bazen boş (ekleri ayrı derleme etiketlerinde) yayımlanıyor.
const ENGINE_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
/// NVIDIA ekran kartı için CUDA 12.4 derlemesi (CUDA çalışma zamanı DLL'leri pakette; yalnızca sürücü gerekir).
const CUDA_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-cublas-12.4.0-bin-x64.zip";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
/// İndirilebilen modeller (ggml-<ad>.bin).
const MODELS: &[&str] = &[
    "tiny",
    "base",
    "small",
    "medium-q5_0",
    "large-v3-turbo-q5_0",
    "large-v3-turbo-q8_0",
    "large-v3-turbo",
    "large-v3-q5_0",
];

static DOWNLOADING: Mutex<Option<String>> = Mutex::new(None);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn root() -> PathBuf {
    store::root().join("whisper")
}
/// İşlemci (`bin`) ya da CUDA (`bin-cuda`) motorunun klasörü.
fn bin_dir(cuda: bool) -> PathBuf {
    root().join(if cuda { "bin-cuda" } else { "bin" })
}
fn cli_path(cuda: bool) -> PathBuf {
    bin_dir(cuda).join(if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" })
}

/// NVIDIA ekran kartının adı (nvidia-smi ile; sürücü yoksa None). Bir kez sorgulanır.
fn nvidia_gpu() -> Option<String> {
    static GPU: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    GPU.get_or_init(|| {
        let mut cmd = std::process::Command::new("nvidia-smi");
        cmd.args(["--query-gpu=name", "--format=csv,noheader"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().ok().filter(|o| o.status.success())?;
        let name = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
        (!name.is_empty()).then_some(name)
    })
    .clone()
}
fn models_dir() -> PathBuf {
    root().join("models")
}
fn model_path(id: &str) -> Result<PathBuf, String> {
    if !MODELS.contains(&id) {
        return Err(format!("Bilinmeyen Whisper modeli: {id}"));
    }
    Ok(models_dir().join(format!("ggml-{id}.bin")))
}

#[derive(Serialize, Clone)]
struct Progress {
    item: String, // "engine" ya da model adı
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Motorun ve indirilmiş modellerin durumu.
#[tauri::command]
pub fn whisper_status() -> Value {
    let models: Vec<Value> = MODELS
        .iter()
        .filter_map(|id| {
            let p = model_path(id).ok()?;
            let size = fs::metadata(&p).ok().filter(|m| m.is_file())?.len();
            Some(json!({ "id": id, "size": size }))
        })
        .collect();
    json!({
        "engine": cli_path(false).is_file(),
        "cuda": cli_path(true).is_file(),
        "gpu": nvidia_gpu(),
        "models": models,
        "downloading": DOWNLOADING.lock().ok().and_then(|g| g.clone()),
        "dir": root().to_string_lossy(),
    })
}

#[tauri::command]
pub fn whisper_cancel_download() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn whisper_delete_model(model: String) -> Result<(), String> {
    let p = model_path(&model)?;
    if DOWNLOADING.lock().ok().and_then(|g| g.clone()).as_deref() == Some(model.as_str()) {
        return Err("Model şu an indiriliyor".into());
    }
    if p.is_file() {
        fs::remove_file(p).map_err(|e| format!("Model silinemedi: {e}"))?;
    }
    Ok(())
}

/// İndirilmiş CUDA motorunu siler (işlemci motoru kalır).
#[tauri::command]
pub fn whisper_delete_cuda() -> Result<(), String> {
    if DOWNLOADING.lock().ok().and_then(|g| g.clone()).as_deref() == Some("cuda") {
        return Err("CUDA paketi şu an indiriliyor".into());
    }
    let dir = bin_dir(true);
    if dir.is_dir() {
        fs::remove_dir_all(dir).map_err(|e| format!("CUDA paketi silinemedi: {e}"))?;
    }
    Ok(())
}

/// Ekran kartı (CUDA) motorunu indirir. İlerleme `whisper-download` olayıyla ("cuda") bildirilir.
#[tauri::command]
pub async fn whisper_download_cuda(app: AppHandle) -> Result<(), String> {
    {
        let mut g = DOWNLOADING.lock().map_err(|e| e.to_string())?;
        if g.is_some() {
            return Err("Başka bir indirme sürüyor".into());
        }
        *g = Some("cuda".into());
    }
    let _guard = DownloadGuard;
    CANCEL.store(false, Ordering::SeqCst);
    let result = install_engine(&app, true).await;
    if let Err(e) = &result {
        let _ = app.emit("whisper-download", Progress { item: "cuda".into(), received: 0, total: 0, done: true, error: Some(e.clone()) });
    }
    result
}

struct DownloadGuard;
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = DOWNLOADING.lock() {
            *g = None;
        }
    }
}

/// Motor eksikse önce motoru, sonra modeli indirir. İlerleme `whisper-download` olayıyla bildirilir.
#[tauri::command]
pub async fn whisper_download(app: AppHandle, model: String) -> Result<(), String> {
    let target = model_path(&model)?;
    {
        let mut g = DOWNLOADING.lock().map_err(|e| e.to_string())?;
        if g.is_some() {
            return Err("Başka bir indirme sürüyor".into());
        }
        *g = Some(model.clone());
    }
    let _guard = DownloadGuard;
    CANCEL.store(false, Ordering::SeqCst);

    let result = async {
        if !cli_path(false).is_file() {
            install_engine(&app, false).await?;
        }
        if !target.is_file() {
            let url = format!("{MODEL_URL}/ggml-{model}.bin");
            download(&app, &model, &url, &target).await?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(e) = &result {
        let _ = app.emit(
            "whisper-download",
            Progress { item: model.clone(), received: 0, total: 0, done: true, error: Some(e.clone()) },
        );
    }
    result
}

async fn install_engine(app: &AppHandle, cuda: bool) -> Result<(), String> {
    let zip_path = root().join(if cuda { "engine-cuda.zip" } else { "engine.zip" });
    let (item, url) = if cuda { ("cuda", CUDA_URL) } else { ("engine", ENGINE_URL) };
    download(app, item, url, &zip_path).await?;
    let res = tauri::async_runtime::spawn_blocking({
        let zip_path = zip_path.clone();
        move || extract_engine(&zip_path, cuda)
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&zip_path);
    res?;
    if !cli_path(cuda).is_file() {
        return Err("İndirilen pakette whisper-cli bulunamadı".into());
    }
    Ok(())
}

/// Zip içinden yalnızca whisper-cli ve DLL'leri düz biçimde motor klasörüne çıkarır.
fn extract_engine(zip_path: &Path, cuda: bool) -> Result<(), String> {
    let f = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Paket açılamadı: {e}"))?;
    let tmp = root().join(if cuda { "bin-cuda.tmp" } else { "bin.tmp" });
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
        let lower = name.to_ascii_lowercase();
        let wanted = lower == "whisper-cli.exe" || (lower.ends_with(".dll") && lower != "sdl2.dll");
        if !wanted || name.is_empty() {
            continue;
        }
        let mut out = fs::File::create(tmp.join(&name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Paket çıkarılamadı: {e}"))?;
    }
    let bin = bin_dir(cuda);
    let _ = fs::remove_dir_all(&bin);
    fs::rename(&tmp, &bin).map_err(|e| format!("Motor kurulamadı: {e}"))
}

async fn download(app: &AppHandle, item: &str, url: &str, target: &Path) -> Result<(), String> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = target.with_extension("part");
    let resp = crate::http::client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("İndirme başlatılamadı: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("İndirme başarısız: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last = Instant::now() - Duration::from_secs(1);
    let emit = |received: u64, done: bool| {
        let _ = app.emit("whisper-download", Progress { item: item.to_string(), received, total, done, error: None });
    };
    emit(0, false);
    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("İndirme iptal edildi".into());
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&part);
                return Err(format!("İndirme kesildi: {e}"));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err(format!("Dosya yazılamadı: {e}"));
        }
        received += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(200) {
            last = Instant::now();
            emit(received, false);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if total > 0 && received != total {
        let _ = fs::remove_file(&part);
        return Err("İndirme eksik kaldı; tekrar deneyin".into());
    }
    fs::rename(&part, target).map_err(|e| e.to_string())?;
    emit(received, true);
    Ok(())
}

/// Yerel çeviri hazır mı (motor ve model indirilmiş mi)?
pub fn ready(model: &str) -> Result<PathBuf, String> {
    let p = model_path(model)?;
    if !(cli_path(false).is_file() || cli_path(true).is_file()) || !p.is_file() {
        return Err("Yerel Whisper modeli indirilmemiş (Ayarlar › Ses ve YouTube bölümünden indirin)".into());
    }
    Ok(p)
}

/// 16 kHz mono WAV dosyasını yerel Whisper ile kelime zamanlı metne çevirir.
/// İlerleme `stt-progress` olayıyla bildirilir: { job, percent } (aynı anda süren işler karışmasın diye
/// çağıranın verdiği iş kimliğiyle).
/// `gpu`: CUDA motoru indirilmişse ekran kartında çalıştırır; başarısız olursa işlemciyle yeniden dener.
pub async fn transcribe(app: &AppHandle, wav: &Path, language: &str, model: &str, job: &str, gpu: bool) -> Result<Value, String> {
    let use_cuda = gpu && cli_path(true).is_file();
    if use_cuda {
        match run(app, wav, language, model, job, true).await {
            Ok(v) => return Ok(v),
            Err(e) if cli_path(false).is_file() => eprintln!("CUDA ile çevrilemedi, işlemciye geçiliyor: {e}"),
            Err(e) => return Err(e),
        }
    }
    run(app, wav, language, model, job, false).await
}

async fn run(app: &AppHandle, wav: &Path, language: &str, model: &str, job: &str, cuda: bool) -> Result<Value, String> {
    let model_file = ready(model)?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let out_base = std::env::temp_dir().join(format!("script-atolyesi-whisper-{}-{stamp}", std::process::id()));
    let out_json = out_base.with_extension("json");
    let lang = match language.trim() {
        "" => "auto".to_string(),
        l => l.to_ascii_lowercase(),
    };

    let mut cmd = tokio::process::Command::new(cli_path(cuda));
    cmd.current_dir(bin_dir(cuda))
        .arg("-m")
        .arg(&model_file)
        .arg("-f")
        .arg(wav)
        .args(["-l", &lang, "-t", &threads.to_string(), "-oj", "-ml", "1", "-sow", "-pp"]);
    // İşlemcide 5 ışınlı arama yerine tek yol (greedy): birkaç kat hızlı, doğruluk farkı küçük.
    // Ekran kartında süre zaten kısa; varsayılan ışın araması korunur.
    if !cuda {
        cmd.args(["-bs", "1", "-bo", "1"]);
    }
    cmd
        .arg("-of")
        .arg(&out_base)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("Yerel Whisper başlatılamadı: {e}"))?;

    // Çıktılar okunmazsa boru dolup süreç takılır: ikisi de sürekli okunur.
    let mut stdout = child.stdout.take().ok_or("çıktı yok")?;
    let stderr = child.stderr.take().ok_or("çıktı yok")?;
    let out_task = tokio::spawn(async move {
        let mut sink = Vec::new();
        let _ = stdout.read_to_end(&mut sink).await;
    });
    let emit = {
        let app = app.clone();
        let job = job.to_string();
        move |p: u32| {
            let _ = app.emit("stt-progress", json!({ "job": job, "percent": p.min(100) }));
        }
    };
    emit(0);
    let emit2 = emit.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(p) = line.split("progress =").nth(1).and_then(|s| s.trim().trim_end_matches('%').trim().parse::<u32>().ok()) {
                emit2(p);
            }
            tail.push(line);
            if tail.len() > 20 {
                tail.remove(0);
            }
        }
        tail
    });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = out_task.await;
    let tail = err_task.await.unwrap_or_default();

    let raw = fs::read(&out_json);
    let _ = fs::remove_file(&out_json);
    if !status.success() || raw.is_err() {
        let msg = tail
            .iter()
            .rev()
            .find(|l| l.to_lowercase().contains("error") || l.to_lowercase().contains("failed"))
            .cloned()
            .unwrap_or_else(|| tail.last().cloned().unwrap_or_default());
        return Err(format!("Yerel Whisper çeviremedi: {}", msg.chars().take(300).collect::<String>()));
    }
    parse_output(&raw.unwrap_or_default())
}

/// whisper-cli JSON çıktısı: `-ml 1 -sow` ile her bölüt tek kelimedir (noktalama kelimeye bitişik).
fn parse_output(raw: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(raw);
    // Kaçışsız denetim karakterleri JSON'u bozmasın.
    let clean: String = text.chars().map(|c| if c.is_control() && !matches!(c, '\n' | '\r' | '\t') { ' ' } else { c }).collect();
    let v: Value = serde_json::from_str(&clean).map_err(|e| format!("Yerel Whisper çıktısı çözülemedi: {e}"))?;
    let mut words = Vec::new();
    let mut parts: Vec<String> = Vec::new();
    for seg in v["transcription"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let w = seg["text"].as_str().unwrap_or("").trim();
        // [BLANK_AUDIO], (müzik) gibi konuşma dışı işaretler atlanır.
        if w.is_empty() || (w.starts_with('[') && w.ends_with(']')) || (w.starts_with('(') && w.ends_with(')')) {
            continue;
        }
        let from = seg["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
        let to = seg["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
        // Kelimenin önündeki boşluk yoksa (ör. noktalama tek başına) önceki kelimeye eklenir.
        let leading_space = seg["text"].as_str().is_some_and(|s| s.starts_with(' '));
        if !leading_space && !words.is_empty() && w.chars().all(|c| !c.is_alphanumeric()) {
            if let Some(last) = words.last_mut() {
                let lw: &mut Value = last;
                let joined = format!("{}{w}", lw["word"].as_str().unwrap_or(""));
                lw["word"] = json!(joined);
                lw["end"] = json!(to);
            }
            if let Some(p) = parts.last_mut() {
                p.push_str(w);
            }
            continue;
        }
        words.push(json!({ "word": w, "start": from, "end": to.max(from) }));
        parts.push(w.to_string());
    }
    let duration = words.last().and_then(|w| w["end"].as_f64()).unwrap_or(0.0);
    Ok(json!({
        "language": v["result"]["language"].as_str().unwrap_or(""),
        "duration": duration,
        "text": parts.join(" "),
        "words": words,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_word_segments() {
        let raw = r#"{"result":{"language":"tr"},"transcription":[
            {"offsets":{"from":0,"to":400},"text":" Merhaba"},
            {"offsets":{"from":400,"to":420},"text":","},
            {"offsets":{"from":500,"to":900},"text":" dünya."},
            {"offsets":{"from":900,"to":2000},"text":" [BLANK_AUDIO]"}
        ]}"#;
        let v = parse_output(raw.as_bytes()).unwrap();
        assert_eq!(v["language"], "tr");
        assert_eq!(v["text"], "Merhaba, dünya.");
        let w = v["words"].as_array().unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[0]["word"], "Merhaba,");
        assert_eq!(w[1]["start"], 0.5);
    }

    #[test]
    fn rejects_unknown_models() {
        assert!(model_path("../x").is_err());
        assert!(model_path("small").is_ok());
    }
}

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use crate::ytdlp;

#[derive(Serialize)]
pub struct Transcript {
    pub lang: String,
    pub auto: bool,
    pub text: String,
    /// Video başlığı (aynı yt-dlp çağrısının çıktısından; alınamazsa None).
    pub title: Option<String>,
}

/// Videoda bulunan bir altyazı seçeneği (elle yazılmış veya otomatik).
#[derive(Serialize)]
pub struct SubOption {
    pub lang: String,
    pub name: String,
    pub auto: bool,
}

#[derive(Serialize)]
pub struct SubtitleList {
    pub title: String,
    pub options: Vec<SubOption>,
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// Zamanlı altyazı satırı: başlangıç (sn) ve metin.
pub type Cue = (f64, String);

/// json3 biçimi: events[].tStartMs + segs[].utf8 → zamanlı satırlar.
pub fn json3_cues(src: &str) -> Result<Vec<Cue>, String> {
    let v: Value = serde_json::from_str(src).map_err(|e| format!("json3 ayrıştırılamadı: {e}"))?;
    let mut cues: Vec<Cue> = vec![];
    for ev in v["events"].as_array().into_iter().flatten() {
        let Some(segs) = ev["segs"].as_array() else { continue };
        let line: String = segs.iter().filter_map(|s| s["utf8"].as_str()).collect();
        let line = collapse_ws(&line);
        if line.is_empty() || cues.last().map(|c| &c.1) == Some(&line) {
            continue;
        }
        let t = ev["tStartMs"].as_f64().unwrap_or(0.0) / 1000.0;
        cues.push((t, line));
    }
    Ok(cues)
}

#[cfg(test)]
pub fn parse_json3(src: &str) -> Result<String, String> {
    Ok(json3_cues(src)?.into_iter().map(|c| c.1).collect::<Vec<_>>().join(" "))
}

/// "HH:MM:SS.mmm" veya "MM:SS.mmm" → saniye.
fn vtt_time(s: &str) -> f64 {
    let s = s.trim().replace(',', ".");
    s.rsplit(':')
        .enumerate()
        .map(|(i, part)| part.parse::<f64>().unwrap_or(0.0) * 60f64.powi(i as i32))
        .sum()
}

/// WebVTT: her metin satırı, bağlı olduğu zaman satırının başlangıcını alır.
/// Etiketler atılır; oto-altyazıdaki kayan (tekrar eden) satırlar temizlenir.
pub fn vtt_cues(src: &str) -> Vec<Cue> {
    let tag = Regex::new(r"<[^>]*>").unwrap();
    let mut cues: Vec<Cue> = vec![];
    let mut cur_t = 0.0;
    for raw in src.lines() {
        let l = raw.trim();
        if let Some((start, _)) = l.split_once("-->") {
            cur_t = vtt_time(start.trim());
            continue;
        }
        if l.is_empty()
            || l.starts_with("WEBVTT")
            || l.starts_with("Kind:")
            || l.starts_with("Language:")
            || l.starts_with("NOTE")
            || l.chars().all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let l = collapse_ws(&decode_entities(&tag.replace_all(l, "")));
        if l.is_empty() || cues.last().map(|c| &c.1) == Some(&l) {
            continue;
        }
        cues.push((cur_t, l));
    }
    cues
}

#[cfg(test)]
pub fn parse_vtt(src: &str) -> String {
    vtt_cues(src).into_iter().map(|c| c.1).collect::<Vec<_>>().join(" ")
}

/// Satırları `[dk:sn] metin` biçiminde yazar; AI çıktısında cümle zamanını geri bulmak için.
pub fn timed_text(cues: &[Cue]) -> String {
    cues.iter()
        .map(|(t, text)| {
            let total = t.max(0.0).round() as u64;
            format!("[{:02}:{:02}] {}", total / 60, total % 60, text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn check_url(url: &str) -> Result<(), String> {
    if !url.starts_with("http") {
        return Err("Geçerli bir video bağlantısı girin".into());
    }
    Ok(())
}

fn is_rate_limited(out: &std::process::Output) -> bool {
    String::from_utf8_lossy(&out.stderr).contains("429")
}

/// YouTube bazen HTTP 429 (istek sınırı) döner; kısa aralıklarla birkaç kez denenir.
pub(crate) async fn run_with_retry(args: impl Fn() -> Vec<String>) -> Result<std::process::Output, String> {
    ytdlp::status("YouTube'a bağlanılıyor…");
    let mut out = ytdlp::run(args()).await?;
    // YouTube'un 429 sınırı dakikalarca sürebilir; bekleme süreleri kademeli artar (toplam ~100 sn).
    for (i, wait) in [10u64, 30, 60].into_iter().enumerate() {
        if out.status.success() || !is_rate_limited(&out) {
            break;
        }
        ytdlp::status(&format!("YouTube geçici olarak sınırladı; {wait} sn sonra yeniden deneniyor ({}/3)", i + 1));
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        ytdlp::status("Yeniden deneniyor…");
        out = ytdlp::run(args()).await?;
    }
    Ok(out)
}

const RATE_LIMIT_MSG: &str =
    "YouTube bu bağlantıyı geçici olarak sınırladı (HTTP 429). Birkaç dakika bekleyip tekrar deneyin.";

async fn video_info(url: &str) -> Result<Value, String> {
    let out = run_with_retry(|| {
        vec![
            "--skip-download".into(),
            "--dump-single-json".into(),
            "--no-warnings".into(),
            "--no-playlist".into(),
            "--sleep-requests".into(),
            "2".into(),
            url.to_string(),
        ]
    })
    .await?;
    if !out.status.success() && is_rate_limited(&out) {
        return Err(RATE_LIMIT_MSG.into());
    }
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Video bilgisi alınamadı: {}", err.lines().last().unwrap_or("bilinmeyen hata")));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// yt-dlp'nin `subtitles` / `automatic_captions` sözlüğünden seçenekleri çıkarır.
fn sub_options(v: &Value, auto: bool) -> Vec<SubOption> {
    let Some(obj) = v.as_object() else { return vec![] };
    let mut out: Vec<SubOption> = obj
        .iter()
        .map(|(lang, formats)| {
            let name = formats
                .as_array()
                .and_then(|a| a.iter().find_map(|f| f["name"].as_str()))
                .unwrap_or(lang.as_str())
                .to_string();
            SubOption { lang: lang.clone(), name, auto }
        })
        .collect();
    out.sort_by(|a, b| a.lang.cmp(&b.lang));
    out
}

/// Videodaki tüm altyazıları listeler: önce elle yazılmış, sonra otomatik.
#[tauri::command]
pub async fn list_subtitles(url: String) -> Result<SubtitleList, String> {
    check_url(&url)?;
    let info = video_info(&url).await?;
    let title = info["title"].as_str().unwrap_or("Başlıksız").to_string();
    let mut options = sub_options(&info["subtitles"], false);
    options.extend(sub_options(&info["automatic_captions"], true));
    if options.is_empty() {
        return Err("Bu videoda altyazı bulunamadı".into());
    }
    Ok(SubtitleList { title, options })
}

/// Kullanıcının seçtiği tek bir altyazıyı indirip düz metne çevirir.
#[tauri::command]
pub async fn fetch_transcript(url: String, lang: String, auto: bool) -> Result<Transcript, String> {
    check_url(&url)?;

    let dir = std::env::temp_dir().join(format!("sa-sub-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out_tpl = dir.join("sub").to_string_lossy().to_string();
    let track = format!("^{}$", regex::escape(&lang));
    let out = run_with_retry(|| {
        vec![
            "--skip-download".into(),
            "--no-warnings".into(),
            "--no-playlist".into(),
            "--sleep-requests".into(),
            "2".into(),
            "--sleep-subtitles".into(),
            "3".into(),
            if auto { "--write-auto-subs".into() } else { "--write-subs".into() },
            "--sub-langs".into(),
            track.clone(),
            "--sub-format".into(),
            "json3/vtt".into(),
            "-o".into(),
            out_tpl.clone(),
            url.clone(),
        ]
    })
    .await;
    let out = match out {
        Ok(out) => out,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
    };

    let mut text = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            let cues = match ext {
                "json3" => json3_cues(&content).ok(),
                "vtt" => Some(vtt_cues(&content)),
                _ => None,
            };
            if let Some(t) = cues.filter(|c| !c.is_empty()).map(|c| timed_text(&c)) {
                text = Some(t);
                break;
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    let text = text.ok_or_else(|| {
        if is_rate_limited(&out) {
            return RATE_LIMIT_MSG.to_string();
        }
        format!(
            "Altyazı indirilemedi: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        )
    })?;
    Ok(Transcript { lang, auto, text, title: None })
}

fn base_lang(l: &str) -> String {
    l.split(['-', '_']).next().unwrap_or(l).to_lowercase()
}

fn is_en_tr(base: &str) -> bool {
    base == "en" || base == "tr"
}

/// Küçük sayı = daha iyi. Makine çevirisi (özgün dil dışındaki otomatik iz) hiçbir zaman
/// özgün dildeki izin önüne geçmez.
/// 0: özgün dilde elle yazılmış · 1: özgün dilde otomatik (`-orig` dahil) · 2: elle en/tr ·
/// 3: diğer en/tr · 4: geri kalan.
fn lang_rank(lang: &str, auto: bool, orig: Option<&str>) -> (u8, u8) {
    let base = base_lang(lang);
    let sub = match base.as_str() {
        "en" => 0,
        "tr" => 1,
        _ => 2,
    };
    let is_orig_track = lang.ends_with("-orig");
    let main = if orig == Some(base.as_str()) {
        if !auto && !is_orig_track { 0 } else { 1 }
    } else if !auto && is_en_tr(&base) {
        2
    } else if is_en_tr(&base) {
        3
    } else {
        4
    };
    (main, sub)
}

/// Yalnızca metin alınabilecek izleri sıralar. Her indirme tek bir izi ister.
fn ranked_subtitles(info: &Value) -> Vec<SubOption> {
    let mut options = sub_options(&info["subtitles"], false);
    options.extend(sub_options(&info["automatic_captions"], true));
    let original = info["language"].as_str().map(base_lang).or_else(|| {
        let mut originals = options.iter().filter(|opt| opt.auto && opt.lang.ends_with("-orig"));
        let first = originals.next()?;
        // Çok dilli dub içeren videolarda birden fazla "-orig" izi bulunabilir.
        originals.next().is_none().then(|| base_lang(&first.lang))
    });
    options.sort_by_key(|opt| {
        (lang_rank(&opt.lang, opt.auto, original.as_deref()), !opt.lang.ends_with("-orig"))
    });
    options
}

#[derive(Serialize)]
pub struct Chapter {
    pub title: String,
    pub start: f64,
}

#[derive(Serialize)]
pub struct VideoMeta {
    pub title: String,
    pub description: String,
    pub channel: String,
    pub chapters: Vec<Chapter>,
}

/// Video paneli için başlık, kanal ve açıklama (yt-dlp).
#[tauri::command]
pub async fn video_meta(url: String) -> Result<VideoMeta, String> {
    check_url(&url)?;
    let v = video_info(&url).await?;
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let channel = if v["channel"].is_string() { s("channel") } else { s("uploader") };
    let chapters = v["chapters"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|c| Some(Chapter { title: c["title"].as_str()?.to_string(), start: c["start_time"].as_f64()? }))
                .collect()
        })
        .unwrap_or_default();
    Ok(VideoMeta { title: s("title"), description: s("description"), channel, chapters })
}

/// Kare görüntüleyici için videonun doğrudan (sessiz) görüntü akışı adresi (yt-dlp -g).
/// WebView2'nin çözebildiği kodekler öne alınır; en fazla 1080p.
#[tauri::command]
pub async fn video_stream_url(url: String) -> Result<String, String> {
    check_url(&url)?;
    let out = ytdlp::run(vec![
        "-g".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "-f".into(),
        "bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080][vcodec^=vp9]/bv*[height<=1080]/b".into(),
        url,
    ])
    .await?;
    if !out.status.success() {
        if is_rate_limited(&out) {
            return Err(RATE_LIMIT_MSG.into());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Video akışı alınamadı: {}", err.lines().last().unwrap_or("bilinmeyen hata")));
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .map(String::from)
        .ok_or_else(|| "Video akışı bulunamadı".into())
}

/// Varsayılan altyazıyı alır: özgün dildeki iz, yoksa İngilizce/Türkçe, yoksa videodaki ilk altyazı.
#[tauri::command]
pub async fn fetch_default_transcript(url: String) -> Result<Transcript, String> {
    check_url(&url)?;
    let info = video_info(&url).await?;
    let title = info["title"].as_str().map(str::to_owned);
    let mut last_error = "Bu videoda kullanılabilir altyazı bulunamadı".to_string();
    for option in ranked_subtitles(&info) {
        match fetch_transcript(url.clone(), option.lang, option.auto).await {
            Ok(mut transcript) => {
                transcript.title = title;
                return Ok(transcript);
            }
            Err(error) if error == RATE_LIMIT_MSG => return Err(error),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json3_basic() {
        let s = r#"{"events":[{"tStartMs":0},{"segs":[{"utf8":"Merhaba"},{"utf8":" dünya"}]},{"segs":[{"utf8":"\n"}]},{"segs":[{"utf8":"ikinci satır"}]}]}"#;
        assert_eq!(parse_json3(s).unwrap(), "Merhaba dünya ikinci satır");
    }

    #[test]
    fn vtt_auto_rolling_dedup() {
        let s = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000 align:start position:0%\nhello <00:00:00.500><c>world</c>\n\n00:00:02.000 --> 00:00:03.000\nhello world\nthis is a test\n\n00:00:03.000 --> 00:00:04.000\nthis is a test\nof dedup\n";
        assert_eq!(parse_vtt(s), "hello world this is a test of dedup");
    }

    #[test]
    fn vtt_cues_keep_start_times() {
        let s = "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nilk satır\n\n00:01:05.000 --> 00:01:07.000\nikinci\n";
        assert_eq!(timed_text(&vtt_cues(s)), "[00:02] ilk satır\n[01:05] ikinci");
    }

    #[test]
    fn json3_cues_keep_start_times() {
        let s = r#"{"events":[{"tStartMs":4000,"segs":[{"utf8":"Merhaba"}]},{"tStartMs":9000,"segs":[{"utf8":"dünya"}]}]}"#;
        assert_eq!(timed_text(&json3_cues(s).unwrap()), "[00:04] Merhaba\n[00:09] dünya");
    }

    #[test]
    fn vtt_entities() {
        assert_eq!(
            parse_vtt("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nA &amp; B &gt;&gt; C\n"),
            "A & B >> C"
        );
    }

    #[test]
    fn sub_options_lists_manual_and_auto() {
        let v: Value = serde_json::from_str(
            r#"{"tr":[{"ext":"vtt","name":"Türkçe"}],"en":[{"ext":"vtt"}]}"#,
        )
        .unwrap();
        let opts = sub_options(&v, false);
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0].lang, "en");
        assert_eq!(opts[0].name, "en"); // isim yoksa dil kodu kullanılır
        assert_eq!(opts[1].name, "Türkçe");
        assert!(opts.iter().all(|o| !o.auto));
        assert!(sub_options(&Value::Null, true).is_empty());
    }

    #[test]
    fn default_prefers_manual_original_then_original_asr() {
        let info = serde_json::json!({
            "language": "en-US",
            "subtitles": {"en": [{}], "tr": [{}]},
            "automatic_captions": {"en": [{}], "en-orig": [{}], "de-orig": [{}], "tr": [{}]}
        });
        let options = ranked_subtitles(&info);
        assert_eq!((&*options[0].lang, options[0].auto), ("en", false));
        assert_eq!((&*options[1].lang, options[1].auto), ("en-orig", true));
        assert_eq!((&*options[2].lang, options[2].auto), ("en", true));
    }

    #[test]
    fn uses_unique_original_track_when_language_metadata_is_missing() {
        let info = serde_json::json!({
            "subtitles": {"tr": [{}]},
            "automatic_captions": {"en": [{}], "de-orig": [{}]}
        });
        assert_eq!(ranked_subtitles(&info)[0].lang, "de-orig");
    }

    #[test]
    fn prefers_manual_fallback_when_several_dubs_are_marked_original() {
        let info = serde_json::json!({
            "subtitles": {"tr": [{}]},
            "automatic_captions": {"en-orig": [{}], "de-orig": [{}]}
        });
        assert_eq!(ranked_subtitles(&info)[0].lang, "tr");
    }
}

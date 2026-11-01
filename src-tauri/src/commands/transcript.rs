use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use crate::ytdlp;

#[derive(Serialize)]
pub struct Transcript {
    pub lang: String,
    pub auto: bool,
    pub text: String,
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

/// json3 biçimi: events[].segs[].utf8
pub fn parse_json3(src: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(src).map_err(|e| format!("json3 ayrıştırılamadı: {e}"))?;
    let mut parts: Vec<String> = vec![];
    for ev in v["events"].as_array().into_iter().flatten() {
        let Some(segs) = ev["segs"].as_array() else { continue };
        let line: String = segs.iter().filter_map(|s| s["utf8"].as_str()).collect();
        let line = collapse_ws(&line);
        if line.is_empty() || parts.last() == Some(&line) {
            continue;
        }
        parts.push(line);
    }
    Ok(parts.join(" "))
}

/// WebVTT: zaman satırları ve etiketler atılır; oto-altyazıdaki kayan (tekrar eden) satırlar temizlenir.
pub fn parse_vtt(src: &str) -> String {
    let tag = Regex::new(r"<[^>]*>").unwrap();
    let mut lines: Vec<String> = vec![];
    for raw in src.lines() {
        let l = raw.trim();
        if l.is_empty()
            || l.starts_with("WEBVTT")
            || l.starts_with("Kind:")
            || l.starts_with("Language:")
            || l.starts_with("NOTE")
            || l.contains("-->")
            || l.chars().all(|c| c.is_ascii_digit())
        {
            continue;
        }
        let l = collapse_ws(&decode_entities(&tag.replace_all(l, "")));
        if l.is_empty() || lines.last() == Some(&l) {
            continue;
        }
        lines.push(l);
    }
    lines.join(" ")
}

fn check_url(url: &str) -> Result<(), String> {
    if !url.starts_with("http") {
        return Err("Geçerli bir video bağlantısı girin".into());
    }
    Ok(())
}

async fn video_info(url: &str) -> Result<Value, String> {
    let out = ytdlp::run(vec![
        "--skip-download".into(),
        "--dump-single-json".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        url.to_string(),
    ])
    .await?;
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
    let run = ytdlp::run;

    let dir = std::env::temp_dir().join(format!("sa-sub-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out_tpl = dir.join("sub").to_string_lossy().to_string();
    let out = run(vec![
        "--skip-download".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        if auto { "--write-auto-subs".into() } else { "--write-subs".into() },
        "--sub-langs".into(),
        lang.clone(),
        "--sub-format".into(),
        "json3/vtt".into(),
        "-o".into(),
        out_tpl,
        url,
    ])
    .await?;

    let mut text = None;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            let parsed = match ext {
                "json3" => parse_json3(&content).ok(),
                "vtt" => Some(parse_vtt(&content)),
                _ => None,
            };
            if let Some(t) = parsed.filter(|t| !t.is_empty()) {
                text = Some(t);
                break;
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    let text = text.ok_or_else(|| {
        format!(
            "Altyazı indirilemedi: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        )
    })?;
    Ok(Transcript { lang, auto, text })
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
}

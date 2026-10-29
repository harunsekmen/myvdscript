use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use crate::ytdlp;

#[derive(Serialize)]
pub struct Transcript {
    pub title: String,
    pub lang: String,
    pub auto: bool,
    pub text: String,
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

fn pick_lang(keys: &[String], original: &str) -> Option<String> {
    let has = |k: &str| keys.iter().any(|x| x == k);
    for cand in ["tr", original, "en"] {
        if !cand.is_empty() && has(cand) {
            return Some(cand.to_string());
        }
    }
    keys.first().cloned()
}

fn keys_of(v: &Value) -> Vec<String> {
    v.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
pub async fn fetch_transcript(url: String) -> Result<Transcript, String> {
    if !url.starts_with("http") {
        return Err("Geçerli bir video bağlantısı girin".into());
    }
    let run = ytdlp::run;

    let info_out = run(vec![
        "--skip-download".into(),
        "--dump-single-json".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        url.clone(),
    ])
    .await?;
    if !info_out.status.success() {
        let err = String::from_utf8_lossy(&info_out.stderr);
        return Err(format!("Video bilgisi alınamadı: {}", err.lines().last().unwrap_or("bilinmeyen hata")));
    }
    let info: Value = serde_json::from_slice(&info_out.stdout).map_err(|e| e.to_string())?;
    let title = info["title"].as_str().unwrap_or("Başlıksız").to_string();
    let original = info["language"].as_str().unwrap_or("").to_string();

    let manual = keys_of(&info["subtitles"]);
    let auto_all = keys_of(&info["automatic_captions"]);

    let (lang, is_auto) = if let Some(l) = pick_lang(&manual, &original) {
        (l, false)
    } else {
        // Oto-altyazıda "tr" çoğunlukla makine çevirisidir; önce videonun kendi dilini tercih et.
        let orig_key = auto_all
            .iter()
            .find(|k| k.ends_with("-orig"))
            .cloned()
            .or_else(|| if auto_all.contains(&original) { Some(original.clone()) } else { None });
        let l = orig_key
            .or_else(|| pick_lang(&auto_all, &original))
            .ok_or("Bu videoda altyazı bulunamadı")?;
        (l, true)
    };

    let dir = std::env::temp_dir().join(format!("sa-sub-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out_tpl = dir.join("sub").to_string_lossy().to_string();
    let out = run(vec![
        "--skip-download".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        if is_auto { "--write-auto-subs".into() } else { "--write-subs".into() },
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
    Ok(Transcript { title, lang, auto: is_auto, text })
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
    fn lang_priority() {
        let k = vec!["en".to_string(), "de".to_string()];
        assert_eq!(pick_lang(&k, "de").unwrap(), "de");
        let k = vec!["en".to_string(), "tr".to_string()];
        assert_eq!(pick_lang(&k, "de").unwrap(), "tr");
    }
}

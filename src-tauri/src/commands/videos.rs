//! Ana sayfa için video istatistikleri (izlenme, süre…): yt-dlp birincil, YouTube Data API v3 yedek/isteğe bağlı.
use super::settings;
use crate::{http, store, ytdlp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, sync::Mutex};
use tauri::Emitter;

/// Son ölçümlerden kaç tanesi saklanır ("son açılıştan beri +X" farkı için).
const HISTORY_MAX: usize = 30;
/// Bu süreden sık yapılan ölçümler yeni kayıt açmaz, son kaydın üstüne yazılır.
const HISTORY_GAP_MS: u64 = 60 * 60 * 1000;
/// Aynı anda çalışan yt-dlp süreci sayısı.
const YTDLP_PARALLEL: usize = 3;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Hist {
    pub t: u64,
    pub views: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoStat {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub views: Option<u64>,
    pub likes: Option<u64>,
    pub comments: Option<u64>,
    /// Saniye; 0 = bilinmiyor.
    pub duration: u64,
    /// Yükleme zamanı (ms, UTC); 0 = bilinmiyor.
    pub uploaded_at: u64,
    pub fetched_at: u64,
    pub history: Vec<Hist>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- Kimlik ve tarih yardımcıları ----------

fn valid_vid(s: &str) -> bool {
    (6..=20).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// YouTube bağlantısından (youtu.be, watch?v=, shorts, embed, live) video kimliğini çıkarır.
pub fn video_id(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.trim_start_matches("www.").trim_start_matches("m.");
    let cand = if host == "youtu.be" {
        path.split(['/', '?', '#']).next().unwrap_or("").to_string()
    } else if host == "youtube.com" || host == "youtube-nocookie.com" {
        let (p, q) = path.split_once('?').unwrap_or((path, ""));
        let q = q.split('#').next().unwrap_or("");
        if let Some(v) = q.split('&').find_map(|kv| kv.strip_prefix("v=")) {
            v.to_string()
        } else {
            let mut it = p.split('/');
            match (it.next(), it.next()) {
                (Some("shorts" | "embed" | "live" | "v"), Some(id)) => id.to_string(),
                _ => String::new(),
            }
        }
    } else {
        String::new()
    };
    valid_vid(&cand).then_some(cand)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn to_ms(y: i64, mo: i64, d: i64, secs: i64) -> u64 {
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return 0;
    }
    ((days_from_civil(y, mo, d) * 86400 + secs).max(0) as u64) * 1000
}

/// yt-dlp'nin `upload_date` değeri: "YYYYMMDD".
fn parse_ymd(s: &str) -> u64 {
    if s.len() != 8 || !s.chars().all(|c| c.is_ascii_digit()) {
        return 0;
    }
    let n = |r: std::ops::Range<usize>| s[r].parse::<i64>().unwrap_or(0);
    to_ms(n(0..4), n(4..6), n(6..8), 0)
}

/// API'nin `publishedAt` değeri: "2020-01-02T03:04:05Z".
fn parse_iso_ts(s: &str) -> u64 {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' {
        return 0;
    }
    let n = |r: std::ops::Range<usize>| s.get(r).and_then(|x| x.parse::<i64>().ok()).unwrap_or(-1);
    let (y, mo, d, h, mi, se) = (n(0..4), n(5..7), n(8..10), n(11..13), n(14..16), n(17..19));
    if [y, mo, d, h, mi, se].iter().any(|v| *v < 0) {
        return 0;
    }
    to_ms(y, mo, d, h * 3600 + mi * 60 + se)
}

/// ISO-8601 süre ("PT1H2M3S", "P1DT30S") → saniye.
pub fn parse_iso_duration(s: &str) -> u64 {
    let Some(rest) = s.strip_prefix('P') else { return 0 };
    let (mut total, mut n, mut in_time) = (0u64, 0u64, false);
    for c in rest.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => n = n * 10 + c.to_digit(10).unwrap() as u64,
            'D' => {
                total += n * 86400;
                n = 0;
            }
            'H' if in_time => {
                total += n * 3600;
                n = 0;
            }
            'M' if in_time => {
                total += n * 60;
                n = 0;
            }
            'S' if in_time => {
                total += n;
                n = 0;
            }
            _ => n = 0,
        }
    }
    total
}

// ---------- Ayrıştırıcılar ----------

fn num(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).or_else(|| v.as_str()?.parse().ok())
}

/// `yt-dlp -j` çıktısı: her satır bir video JSON'u. Geçersiz satırlar atlanır.
pub fn parse_ytdlp_lines(text: &str) -> Vec<VideoStat> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .filter_map(|v| {
            let id = v["id"].as_str()?.to_string();
            if !valid_vid(&id) {
                return None;
            }
            let s = |k: &str| v[k].as_str().map(str::to_string);
            let ts = v["timestamp"].as_u64().map(|t| t * 1000).unwrap_or(0);
            let date = parse_ymd(v["upload_date"].as_str().unwrap_or(""));
            Some(VideoStat {
                id,
                title: s("title").unwrap_or_default(),
                channel: s("channel").or_else(|| s("uploader")).unwrap_or_default(),
                views: num(&v["view_count"]),
                likes: num(&v["like_count"]),
                comments: num(&v["comment_count"]),
                duration: num(&v["duration"]).unwrap_or(0),
                uploaded_at: if ts > 0 { ts } else { date },
                ..Default::default()
            })
        })
        .collect()
}

/// `videos.list` yanıtı.
pub fn parse_api_items(v: &Value) -> Vec<VideoStat> {
    v["items"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|it| {
                    let id = it["id"].as_str()?.to_string();
                    let st = &it["statistics"];
                    Some(VideoStat {
                        id,
                        title: it["snippet"]["title"].as_str().unwrap_or("").to_string(),
                        channel: it["snippet"]["channelTitle"].as_str().unwrap_or("").to_string(),
                        views: num(&st["viewCount"]),
                        likes: num(&st["likeCount"]),
                        comments: num(&st["commentCount"]),
                        duration: parse_iso_duration(it["contentDetails"]["duration"].as_str().unwrap_or("")),
                        uploaded_at: parse_iso_ts(it["snippet"]["publishedAt"].as_str().unwrap_or("")),
                        ..Default::default()
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Yeni ölçümü önceki kayıtla birleştirir: geçmiş korunur, eksik alanlar önceki değerden tamamlanır.
pub fn merge_stat(prev: Option<&VideoStat>, mut new: VideoStat, now: u64) -> VideoStat {
    new.fetched_at = now;
    let Some(p) = prev else {
        if let Some(v) = new.views {
            new.history = vec![Hist { t: now, views: v }];
        }
        return new;
    };
    if new.title.is_empty() {
        new.title = p.title.clone();
    }
    if new.channel.is_empty() {
        new.channel = p.channel.clone();
    }
    if new.duration == 0 {
        new.duration = p.duration;
    }
    if new.uploaded_at == 0 {
        new.uploaded_at = p.uploaded_at;
    }
    new.views = new.views.or(p.views);
    new.likes = new.likes.or(p.likes);
    new.comments = new.comments.or(p.comments);
    let mut hist = p.history.clone();
    if let Some(v) = new.views {
        match hist.last_mut() {
            Some(last) if now.saturating_sub(last.t) < HISTORY_GAP_MS => *last = Hist { t: last.t, views: v },
            _ => hist.push(Hist { t: now, views: v }),
        }
    }
    if hist.len() > HISTORY_MAX {
        hist.drain(..hist.len() - HISTORY_MAX);
    }
    new.history = hist;
    new
}

// ---------- Önbellek ----------

static CACHE_LOCK: Mutex<()> = Mutex::new(());

fn cache_path() -> std::path::PathBuf {
    store::root().join("video-stats.json")
}

fn read_cache() -> BTreeMap<String, VideoStat> {
    fs::read_to_string(cache_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Ölçümleri önbelleğe birleştirir (atomik yazım), ön yüze olay yayınlar ve birleşmiş kayıtları döndürür.
fn commit(stats: Vec<VideoStat>) -> Vec<VideoStat> {
    let _g = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cache = read_cache();
    let now = now_ms();
    let merged: Vec<VideoStat> = stats
        .into_iter()
        .map(|s| {
            let m = merge_stat(cache.get(&s.id), s, now);
            cache.insert(m.id.clone(), m.clone());
            m
        })
        .collect();
    if let Ok(bytes) = serde_json::to_vec(&cache) {
        let _ = store::write_atomic(&cache_path(), &bytes);
    }
    if let Some(app) = ytdlp::APP.get() {
        for m in &merged {
            let _ = app.emit("video-stat", m);
        }
    }
    merged
}

#[tauri::command]
pub fn load_video_stats() -> BTreeMap<String, VideoStat> {
    let _g = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_cache()
}

// ---------- Kaynaklar ----------

/// yt-dlp'nin her video için yazdıracağı tek satırlık JSON (tam döküm video başına ~10 MB tutuyor).
const PRINT_TPL: &str = "%(.{id,title,channel,uploader,view_count,like_count,comment_count,duration,upload_date,timestamp})j";

/// Bir grup video için tek yt-dlp süreci; her satır geldiği anda önbelleğe yazılır ve ön yüze yayınlanır.
async fn ytdlp_group(ids: Vec<String>) -> (Vec<VideoStat>, Option<String>) {
    let mut args: Vec<String> = [
        "--skip-download",
        "--no-playlist",
        "--ignore-errors",
        "--no-warnings",
        "--extractor-args",
        "youtube:skip=dash,hls",
        "--print",
        PRINT_TPL,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(ids.iter().map(|id| format!("https://www.youtube.com/watch?v={id}")));
    let mut got = vec![];
    let res = ytdlp::run_lines(args, |line| got.extend(commit(parse_ytdlp_lines(line)))).await;
    let err = match res {
        Err(e) => Some(e),
        Ok((_, stderr)) if got.len() < ids.len() => {
            stderr.lines().rev().find(|l| l.contains("ERROR")).or(stderr.lines().last()).map(|l| l.trim().to_string())
        }
        Ok(_) => None,
    };
    (got, err)
}

async fn fetch_ytdlp(ids: &[String], out: &mut Vec<VideoStat>) -> Result<(), String> {
    // Videolar YTDLP_PARALLEL sürece dağıtılır (her video ağda ~5 sn sürüyor).
    let n = YTDLP_PARALLEL.min(ids.len()).max(1);
    let mut groups: Vec<Vec<String>> = vec![vec![]; n];
    for (i, id) in ids.iter().enumerate() {
        groups[i % n].push(id.clone());
    }
    let results = futures_util::future::join_all(groups.into_iter().map(ytdlp_group)).await;
    let mut last_err = None;
    for (got, err) in results {
        out.extend(got);
        if err.is_some() {
            last_err = err;
        }
    }
    match (out.is_empty(), last_err) {
        (true, Some(e)) => Err(e),
        (true, None) => Err("Video bilgisi alınamadı".into()),
        _ => Ok(()),
    }
}

fn api_error(status: reqwest::StatusCode, body: &Value) -> String {
    let msg = body["error"]["message"].as_str().unwrap_or("bilinmeyen hata");
    format!("YouTube API hatası ({}): {msg}", status.as_u16())
}

async fn fetch_api(ids: &[String], key: &str, out: &mut Vec<VideoStat>) -> Result<(), String> {
    for chunk in ids.chunks(50) {
        let resp = http::client()
            .get("https://www.googleapis.com/youtube/v3/videos")
            .header("x-goog-api-key", key)
            .query(&[("part", "snippet,statistics,contentDetails"), ("id", &chunk.join(","))])
            .send()
            .await
            .map_err(|e| format!("YouTube API'ye ulaşılamadı: {}", e.without_url()))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(api_error(status, &body));
        }
        out.extend(commit(parse_api_items(&body)));
    }
    Ok(())
}

/// Bağlantıların istatistiklerini `statsSource` ayarına göre yeniler; her video bitince "video-stat" olayı yayınlanır.
#[tauri::command]
pub async fn refresh_video_stats(urls: Vec<String>) -> Result<Vec<VideoStat>, String> {
    let mut ids: Vec<String> = vec![];
    for u in &urls {
        if let Some(id) = video_id(u) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mode = settings::setting_str("statsSource");
    let key = settings::youtube_key();
    let mut out: Vec<VideoStat> = vec![];
    match mode.as_str() {
        "api" => {
            let key = key.ok_or("YouTube API anahtarı girilmedi (Ayarlar → Ana sayfa)")?;
            fetch_api(&ids, &key, &mut out).await?;
        }
        "auto" => {
            let first = fetch_ytdlp(&ids, &mut out).await;
            let missing: Vec<String> = ids.iter().filter(|id| !out.iter().any(|s| &s.id == *id)).cloned().collect();
            match (&key, missing.is_empty()) {
                (Some(k), false) => fetch_api(&missing, k, &mut out).await?,
                _ => first?,
            }
        }
        _ => fetch_ytdlp(&ids, &mut out).await?,
    }
    Ok(out)
}

/// Anahtarı hafif bir istekle doğrular.
#[tauri::command]
pub async fn test_youtube_key() -> Result<(), String> {
    let key = settings::youtube_key().ok_or("Önce bir YouTube API anahtarı kaydedin")?;
    let resp = http::client()
        .get("https://www.googleapis.com/youtube/v3/videos")
        .header("x-goog-api-key", key)
        .query(&[("part", "id"), ("id", "dQw4w9WgXcQ")])
        .send()
        .await
        .map_err(|e| format!("YouTube API'ye ulaşılamadı: {}", e.without_url()))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body: Value = resp.json().await.unwrap_or(json!({}));
    Err(api_error(status, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ytdlp_multiline() {
        let t = concat!(
            r#"{"id":"abcdefghijk","title":"A","channel":"K","view_count":1200,"like_count":10,"duration":61.0,"upload_date":"20240102"}"#,
            "\nuyarı: satır\n",
            r#"{"id":"zzzzzzzzzzz","title":"B","uploader":"U","view_count":null,"duration":5,"timestamp":1700000000}"#,
            "\n"
        );
        let v = parse_ytdlp_lines(t);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].views, Some(1200));
        assert_eq!(v[0].duration, 61);
        assert_eq!(v[0].uploaded_at, 1704153600000);
        assert_eq!(v[1].channel, "U");
        assert_eq!(v[1].views, None);
        assert_eq!(v[1].uploaded_at, 1700000000000);
    }

    #[test]
    fn iso_duration() {
        assert_eq!(parse_iso_duration("PT1H2M3S"), 3723);
        assert_eq!(parse_iso_duration("PT45S"), 45);
        assert_eq!(parse_iso_duration("P1DT1M"), 86460);
        assert_eq!(parse_iso_duration("PT0S"), 0);
        assert_eq!(parse_iso_duration("x"), 0);
    }

    #[test]
    fn iso_timestamp() {
        assert_eq!(parse_iso_ts("2024-01-02T00:00:00Z"), 1704153600000);
        assert_eq!(parse_iso_ts("bozuk"), 0);
    }

    #[test]
    fn api_items() {
        let v = json!({"items":[{"id":"abcdefghijk","snippet":{"title":"T","channelTitle":"C","publishedAt":"2024-01-02T00:00:00Z"},
            "statistics":{"viewCount":"1500","likeCount":"3"},"contentDetails":{"duration":"PT2M"}}]});
        let s = parse_api_items(&v);
        assert_eq!(s[0].views, Some(1500));
        assert_eq!(s[0].comments, None);
        assert_eq!(s[0].duration, 120);
        assert_eq!(s[0].uploaded_at, 1704153600000);
    }

    #[test]
    fn ids_from_urls() {
        assert_eq!(video_id("https://youtu.be/abcdefghijk?t=3").as_deref(), Some("abcdefghijk"));
        assert_eq!(video_id("https://www.youtube.com/watch?v=abcdefghijk&list=x").as_deref(), Some("abcdefghijk"));
        assert_eq!(video_id("https://m.youtube.com/shorts/abcdefghijk").as_deref(), Some("abcdefghijk"));
        assert_eq!(video_id("https://example.com/watch?v=abcdefghijk"), None);
        assert_eq!(video_id("--exec x"), None);
    }

    #[test]
    fn merge_keeps_history() {
        let mk = |v| VideoStat { id: "a".into(), views: Some(v), ..Default::default() };
        let a = merge_stat(None, mk(100), 1_000);
        assert_eq!(a.history.len(), 1);
        // 1 saatten kısa: son kaydın üstüne yazılır
        let b = merge_stat(Some(&a), mk(110), 2_000);
        assert_eq!(b.history, vec![Hist { t: 1_000, views: 110 }]);
        // 1 saatten uzun: yeni kayıt
        let c = merge_stat(Some(&b), mk(150), 1_000 + HISTORY_GAP_MS + 1);
        assert_eq!(c.history.len(), 2);
        // Eksik alan önceki değerden gelir
        let d = merge_stat(Some(&c), VideoStat { id: "a".into(), ..Default::default() }, 9_999_999_999);
        assert_eq!(d.views, Some(150));
        // Üst sınır
        let mut cur = c;
        for i in 0..50u64 {
            cur = merge_stat(Some(&cur), mk(200 + i), 10_000_000 + i * (HISTORY_GAP_MS + 1));
        }
        assert_eq!(cur.history.len(), HISTORY_MAX);
    }
}

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

#[derive(Serialize)]
pub struct Speech {
    lang: String,
    audio: String, // base64 MP3
}

/// Metnin dilini Google'ın ücretsiz çeviri servisiyle algılar; başarısızsa "en".
async fn detect_lang(client: &reqwest::Client, text: &str) -> String {
    let res = async {
        let v: Value = client
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[("client", "gtx"), ("sl", "auto"), ("tl", "en"), ("dt", "t"), ("q", text)])
            .header("User-Agent", UA)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        v[2].as_str().map(String::from)
    }
    .await;
    res.unwrap_or_else(|| "en".into())
}

/// Dili otomatik algılayıp ücretsiz bulut sesiyle (Google Translate TTS) okutur.
#[tauri::command]
pub async fn tts(text: String) -> Result<Speech, String> {
    let text: String = text.trim().chars().take(200).collect();
    if text.is_empty() {
        return Err("Boş metin".into());
    }
    let client = reqwest::Client::new();
    let lang = detect_lang(&client, &text).await;
    let resp = client
        .get("https://translate.google.com/translate_tts")
        .query(&[("ie", "UTF-8"), ("client", "tw-ob"), ("tl", lang.as_str()), ("q", text.as_str())])
        .header("User-Agent", UA)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Ses servisine bağlanılamadı: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Ses servisi HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(Speech { lang, audio: STANDARD.encode(bytes) })
}

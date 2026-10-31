# Script Atölyesi

YouTube script yazım aracı (Tauri 2 + React). Video linkinden altyazı çeker, AI ile Türkçe'ye düzeltir, konu konu gösterir; yanında kendi scriptini yazarsın.

## Geliştirme
- `npm install`
- `src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe` dosyasını koy (yt-dlp'nin bağımsız Windows exe'si; derlemede exe'nin içine gömülür, git'e eklenmez)
- `npm run tauri dev`

## Ses / video → zamanlı metin
Sağ panelde "＋ Ses / video" ile bilgisayardan bir dosya seç; Groq Whisper (`whisper-large-v3`, kelime zamanlı) ile kelime kelime zamanlı metne çevrilir ve "Zamanlı metin" sekmesinde açılır. Ayarlar'dan Groq API anahtarını gir (AI anahtarından ayrı, Windows Kimlik Bilgisi Yöneticisi'nde tutulur). Groq'un dosya boyutu sınırı vardır; sınırı aşan dosyalar Groq tarafından reddedilir.

## Taşınabilir exe
`npm run tauri build -- --no-bundle` → `src-tauri/target/release/script-atolyesi.exe`.
Release exe verilerini yanındaki `ScriptAtolyesi/` klasörüne yazar (yazılamazsa `%APPDATA%`). API anahtarı Windows Kimlik Bilgisi Yöneticisi'nde tutulur.

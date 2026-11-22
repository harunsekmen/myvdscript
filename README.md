# Script Atölyesi

YouTube script yazım aracı (Tauri 2 + React). Video linkinden altyazı çeker, AI ile Türkçe'ye düzeltir, konu konu gösterir; yanında kendi scriptini yazarsın.

## Geliştirme
- `npm install`
- `src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe` dosyasını koy (yt-dlp'nin bağımsız Windows exe'si; derlemede exe'nin içine gömülür, git'e eklenmez)
- `npm run tauri dev`

## macOS

- Xcode Command Line Tools, Rust/Cargo ve Node.js 24 ile npm gerekir.
- Homebrew ile `brew install yt-dlp deno ffmpeg`. FFmpeg medya dönüştürme ve ses birleştirme içindir.
- `npm ci` ve `npm run tauri dev` ile geliştirin.
- `npm run tauri build -- --bundles app` ile `src-tauri/target/release/bundle/macos/` altında uygulama paketi oluşturun.
- API anahtarları macOS Keychain'de saklanır. Projeler ve ayarlar `~/Library/Application Support/ScriptAtolyesi` altındadır.
- Metin işlemesi için Ayarlar › Yapay zekâ bölümünden OpenAI uyumlu bir sunucu ve model seçin. Yerel sunucu kendi başına çalışır ve API anahtarı gerektirmeyebilir.
- Ses dökümü için Groq seçeneği kullanılabilir. Uygulama içinden indirilen yerel Whisper motoru ve CUDA paketi Windows içindir.

## Kaynak videolar
- **Çoklu kaynak:** Bir projede birden çok video kaynak olabilir. Sol panelde kaynak sekmeleri görünür; "＋ Kaynak" ile başka bir YouTube bağlantısı eklenir (başlık isteğe bağlı), `×` ile kaynak silinir. Her kaynağın altyazısı, bölümleri ve açıklamaları (✦ Açıkla) kendine aittir; orta paneldeki video etkin kaynağı oynatır. Eski tek kaynaklı projeler ilk açılışta otomatik dönüştürülür.
- **Yeniden işle ▾:** varsayılan istemle yeniden işle, özel istemle işle, **Başka altyazı seç…** (videodaki diğer diller/otomatik çeviri) ve **Önceki işlemeye dön**. Yeniden işlemeden önceki sürüm (bölümler + açıklamalar) kaynak başına son 3 sürüm olarak saklanır; geri dönünce güncel sürüm onunla yer değiştirir.
- **Hata dayanıklılığı:** AI isteği başarısız olan parça 2 kez (2 sn, 5 sn bekleyerek) otomatik yeniden denenir. Yine olmazsa ya da işlemi iptal edersen, hata çubuğundaki **Kaldığı yerden devam et** tamamlanan parçaları atmadan kalan parçalardan sürdürür; **Yeniden dene** baştan başlatır.

## Ses / video → zamanlı metin
Sağ panelde "＋ Ses / video" ile bilgisayardan bir dosya seç; Groq Whisper (`whisper-large-v3`, kelime zamanlı) ile kelime kelime zamanlı metne çevrilir ve "Zamanlı metin" sekmesinde açılır. Ayarlar'dan Groq API anahtarını gir (AI anahtarından ayrı, Windows Kimlik Bilgisi Yöneticisi'nde tutulur). Groq'un dosya boyutu sınırı vardır; sınırı aşan dosyalar Groq tarafından reddedilir.

## Taşınabilir exe
`npm run tauri build -- --no-bundle` → `src-tauri/target/release/script-atolyesi.exe`.
Veriler (ayarlar, projeler, resimler) exe'nin konumundan bağımsız olarak her zaman `%APPDATA%\ScriptAtolyesi` altında tutulur; eski sürümlerin exe yanındaki `ScriptAtolyesi/` klasörü ilk açılışta bir kez buraya taşınır. API anahtarı Windows Kimlik Bilgisi Yöneticisi'nde tutulur.

# Script Atölyesi geliştirme planı

Codex CLI, yeni kurulumlarda metin işleme sağlayıcısıdır. Mevcut kurulumlar kayıtlı API tercihlerini korur. OpenAI uyumlu API ile yerel model bağlantıları kullanılabilir. İlk akış, Nate Herk videosunun altyazısını alıp Türkçeye çevirmek ve senaryoyu koruyarak yeniden açmaktır.

| Faz | Teslim | Kabul |
| --- | --- | --- |
| 0 | [Codex CLI sözleşmesi](codex-integration.md) | stdin, JSONL, JSON Schema, hesap erişimi, hata, iptal ve araç sınırları sürüme göre doğrulanır. |
| 1 | macOS resim yolları, kısayollar ve CI | Eski Windows ve macOS proje yolları açılır. Mac tuşları işletim sistemiyle çakışmaz. macOS ve Windows Rust işleri, Linux web işi geçer. |
| 2 | Sağlayıcı seçimi, Codex adaptörü ve API fallback | Bağlantı testi sürüm ve oturum bilgisini gösterir. Tüm metin çağrıları aynı yönlendirmeyi kullanır. İptal süreç bırakmaz. Çıkış başlamadan önceki binary veya auth hatasında yapılandırılmış API kullanılır ve uygulama bunu bildirir. |
| 3 | Açıklama ve iddia doğrulama | Açıklamalar ve iddia kontrolleri ayrı kaydolur. Yalnız doğrulanmış web araması ve kaynakla kanıt durumu gösterilir. Web işlemi yoksa sonuç “Doğrulanamadı” olarak kalır. |
| 4 | Çoklu kaynak sentezi | Üç kaynaktan 1.200–1.800 kelimelik örnek taslak, ham altyazı referansına bağlı zaman damgaları, tıklanabilir önizleme ve editöre geri alınabilir temiz aktarım. Tamamlanan kaynak özetleri iptal ve yeniden açma sonrasında tekrar kullanılabilir. |
| 5 | Yayın sekmesi | Beş başlık, açıklama, bölüm önerileri, etiketler, sabit yorum ve seçimden 45–60 sn Shorts taslağı ve üç giriş önerisi. Düzenlenebilir ve kalıcı çıktılar. Tahmini SRT açıkça etiketlenir. Gerçek kayıt zamanları varsa mevcut SRT yolu kullanılır. |
| 6 | Yedek, log, tanılama ve updater | Günlük proje ve ayar anlık görüntüleri, geri yükleme öncesi yedek ve toplu silme öncesi doğrulanmış medya dahil arşiv. Tanılama arşivinde yalnız güvenli metadata. İmzalı bir test kanalında updater ve yeniden başlatma doğrulanır. |
| 7 | 0.2.0 release | Mac ve Windows paketleri, smoke test, changelog, etiket ve draft release. Dış dağıtım koşulları ve kullanılabilir imza anahtarları doğrulanır. |

## Codex kararları

- Uygulama `codex exec --json` çağırır. Prompt stdin’den gider. Yapılandırılmış çıktı `--output-schema` ile alınır ve uygulamada tekrar doğrulanır. Windows komut satırı eşiği prompt için uygulanmaz. Sentezde bağlam ve kalite için gerektiğinde kaynak özetleri kullanılır.
- Her istek ayrı geçici klasörde ve geçici oturumda çalışır. Kullanıcı yapılandırması, kurallar, eklentiler, bağlantılar, shell ve alt ajan çalıştırma devre dışı bırakılır. Araçsız işlerde web kapalıdır. İstek bütünüyle iptal edilebilir. Kalan CLI olayları terminal sonuçlarıyla karıştırılmaz.
- Model boşsa CLI varsayılanı seçilir. İsteğe bağlı model ve muhakeme eforu Codex ayarlarında saklanır. API modeli ve sıcaklığı kendi ayarlarını korur.
- Codex uygulama içindeki mevcut ChatGPT/CLI oturumunu kullanacak şekilde çalışır. Uygulama kimlik doğrulama dosyasını okumaz. CLI oturum durumu ve gerçek metin isteği farklı kontrollerdir.
- Fact-check için canlı web ayrı istek türüdür. Başarılı bir web olayı ve denetlenebilir kaynak gerekir. Sentez atıfları web kaynaklarından ayrı biçimde ham YouTube altyazı satırına bağlanır.
- Yeni veri alanları isteğe bağlıdır. Eski projeler açılmaya devam eder. Üretilen sonuçlar kendiliğinden senaryoyu değiştirmez.

## Dağıtım

Tauri updater imzası, işletim sisteminin kod imzalama ve notarization sürecinden ayrıdır. Güncel Tauri Action ayarı `uploadUpdaterJson` kullanır. Portable Windows exe elle değiştirilir. Geliştirme ve yerel Mac derlemeleri release anahtarı beklemeden ilerler. Depo lisansı ve macOS Developer ID durumu kamusal sürüm öncesi ayrıca doğrulanır.

Kapsam dışında altyazısız YouTube için Whisper geçişi, global arama, teleprompter ve sürüm diff’i kalır.

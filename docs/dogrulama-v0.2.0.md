# Script Atölyesi 0.2.0 doğrulaması

Mac testi, uygulamanın kendi arayüzünde [Nate Herk videosunun](https://www.youtube.com/watch?v=8Pg6G5h05hk) kayıtlı İngilizce altyazısıyla yapıldı. Üç kaynaklı denemede tam altyazı ve aynı videonun iki ayrı kesiti kullanıldı. İddia doğrulama için YouTube’un SRT desteği ayrıca sınandı.

| Faz | Değişen alan | Doğrulama |
| --- | --- | --- |
| 0 | `docs/codex-integration.md` | Codex CLI 0.166.0, ChatGPT oturumu, stdin, 24 bin karakter üzeri girdi, yapılandırılmış JSON ve canlı arama olayları doğrulandı. İlerleme, parça ve kaynak bazında gösteriliyor. |
| 1 | `store.rs`, `commands/projects.rs`, `keys.ts`, CI | Karışık macOS ve eski Windows resim yolları otomatik testlerden geçti. macOS ve Windows Rust, Linux web işleri geçti. Mac ana sayfa kısayolu uygulamada çalıştı. |
| 2 | `commands/codex.rs`, `commands/ai.rs`, `aiProvider.ts`, ayarlar | Nate Herk altyazısı Türkçe altı bölüme çevrildi. Aktif gerçek Codex isteği ve alt süreç iptal edildi. Eski API ayarları için geçiş ve yapılandırılmış fallback testleri geçti. |
| 3 | `insights.ts`, `InsightCard.tsx`, `LeftPane.tsx` | SRT iddiası Codex canlı aramasında desteklendi ve [YouTube Yardım](https://support.google.com/youtube/answer/2734698) bağlantısıyla kaydoldu. Arama sonucunda bulunmayan bağlantılar ile kanıtsız sonuçlar birim testlerinde elendi. |
| 4 | `synthesis.ts`, `useSynthesis.ts`, `SynthesisDialog.tsx`, editör ve oynatıcı | Üç kaynaklı tekrar 1.272 temiz kelime ve 38 altyazı atfı üretti. İptalden sonra iki tamamlanmış özet tekrar kullanıldı. Atıf 4:32’ye geçti ve oynat düğmesi bu konumu kullandı. Metin editöre atıf işareti temizlenerek eklendi, tek geri alma mevcut metni korudu. |
| 5 | `publish.ts`, `PublishPane.tsx`, SRT dışa aktarımı | Beş başlık, açıklama, bölüm, on etiket ve sabit yorum üretildi. Seçimden 54 saniyelik Shorts ve üç giriş oluştu. Tahmini SRT 119 blok içeriyordu, süreleri 1,2–5,25 saniyeydi. FFplay dosyayı açtı. Çıktılar kayıt ve geri yüklemede korundu. |
| 6 | `backups.rs`, `diagnostics.rs`, `updates.rs`, `DataSettings.tsx` | Mac arayüzünde günlük yedek ve geri yükleme öncesi kayıtla geri dönüş doğrulandı. İzole veriyle toplu silme öncesi JSON, resim ve ses arşivi test edildi. 5 MB log döndürüldü ve toplam beş dosya kaldı. Tanılama ZIP’i yalnız sistem, proje metadata ve filtrelenmiş log içerdi. |
| 7 | Sürüm 0.2.0, `CHANGELOG.md`, GitHub Actions | Windows x64 NSIS/MSI ve portable, macOS Apple Silicon ve Intel paketleri taslağa yüklendi. İmzalı NSIS güncellemesi 0.1.99’dan 0.2.0’a kuruldu ve uygulamayı yeniden başlattı. |

Yerelde `npm ci`, TypeScript, 176 Vitest testi, Vite derlemesi, 34 Rust testi ve Clippy geçti. Oturum gerektiren canlı Rust testi ayrıca çalıştırılıp geçti.

Düzenlenen senaryo disk kaydında ve uygulamanın yeniden açılışında doğrulandı. Windows masaüstü testi kontrollü yerel sağlayıcıyla altyazı işleme, iddia kartı, sentez, editöre aktarım, yayın ve günlük yedeği çalıştırdı.

Bu Mac’te Codex, Finder’dan başlatılan uygulamanın alt süreci olarak korumalı klasörlere bağlanan mevcut becerileri tararken bekledi. Yerel başlatıcı uygulama paketinin çalıştırılabilir dosyasını Terminal bağlamında açar. Senaryo ve yayın verileri uygulamanın mevcut veri klasöründe durur.

GitHub sürümü taslaktır. Depoların GitHub lisans alanı boş. macOS dağıtımı manuel indirme kullanır.

[Paketleme ve imzalı Windows güncelleme çalışması](https://github.com/harunsekmen/myvdscript/actions/runs/45085832197) · [Windows masaüstü testi](https://github.com/harunsekmen/myvdscript/actions/runs/45086873773)

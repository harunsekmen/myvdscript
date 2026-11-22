# Codex CLI sözleşmesi

Yerelde denenen sürüm `codex-cli 0.166.0`. `codex login status` mevcut ChatGPT oturumunu bildirdi. Oturum bilgisi uygulamaya aktarılmaz.

| İşlev | Doğrulama |
| --- | --- |
| Headless ve stdin | İzole çalışma klasöründen `codex exec --ephemeral --json -` ile Türkçe çıktı alındı. |
| Uzun girdi ve şema | 24.000 karakteri aşan Türkçe test girdisi stdin üzerinden işlendi ve `--output-schema` nesnesi çözüldü. |
| JSONL | `thread.started`, `turn.started`, `item.completed` içinde `agent_message` ve `turn.completed` gözlendi. Bu sürümde kullanıcıya görünür metin tamamlanan mesaj olarak geliyor. |
| Gerçek örnek | Nate Herk videosunun ilk zaman damgalı cümlesi `gpt-6-luna` ile Türkçeye çevrildi. |
| Kimlik, izin, platform | Unix iptali sahte alt süreçle doğrulandı. Canlı web araması YouTube Help URL’lerini JSONL araç olayında döndürdü. Windows iptali ve oturumsuz hata ayrı kabul kontrolleri. |

Argümanlar doğrudan alt sürece verilir. Prompt her zaman stdin üzerinden gönderilir. Uygulama işleri geçici bir dizinde, read-only sandbox, `-a never`, geçici oturum, kullanıcı yapılandırması ve kuralları kapalı çalıştırır. Uygulama, eklenti, hook, shell, snapshot, alt ajan ve MCP bağlantıları kapatılır. Kullanıcı metni talimatlardan ayrı bir JSON alanında tutulur. Web yalnız doğrulama isteğinde açılır.

Bağlantı testi yerel binary ve login durumuna bakar. Model önerileri CLI’nin yerel kataloğundan gelir. Bir modelin listede olması hesap erişimini garanti etmez. Yerel testte `gpt-6-luna` çalıştı.

[Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) · [Codex config reference](https://developers.openai.com/codex/config-reference)

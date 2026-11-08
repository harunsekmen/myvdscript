//! Uygulama genelinde paylaşılan HTTP istemcisi (bağlantı havuzu yeniden kullanılır).
use std::{sync::LazyLock, time::Duration};

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default()
});

pub fn client() -> &'static reqwest::Client {
    &CLIENT
}

use std::{fs, path::Path};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

// Only the disposable Windows app built by the release smoke job enables this feature.
pub fn start(app: &AppHandle) {
    if !std::env::args_os().any(|arg| arg == "--verify-windows-updater") {
        return;
    }
    let Some(result_file) = std::env::var_os("SCRIPT_ATOLYESI_UPDATE_SMOKE_RESULT") else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let path = Path::new(&result_file);
        let result = async {
            if !crate::commands::updates::automatic_update_supported() {
                return Err("NSIS bundle marker missing".to_string());
            }
            let updater = app.updater().map_err(|err| err.to_string())?;
            let update = updater
                .check()
                .await
                .map_err(|err| err.to_string())?
                .ok_or("No update in local test manifest")?;
            if update.version != "0.2.0" {
                return Err(format!("Unexpected update version {}", update.version));
            }
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|err| err.to_string())?;
            fs::write(path, "signature_verified").map_err(|err| err.to_string())?;
            update.install(bytes).map_err(|err| err.to_string())
        }
        .await;
        if let Err(error) = result {
            let _ = fs::write(path, format!("error {error}"));
            app.exit(1);
        }
    });
}

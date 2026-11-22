mod commands;
mod http;
#[cfg(target_os = "macos")]
mod mac_tools;
mod store;
mod ytdlp;
#[cfg(target_os = "macos")]
mod youtube_embed;

use commands::{ai, backups, codex, diagnostics, export, external, images, projects, settings, stt, transcript, tts, updates, videos, voice, whisper};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::new()
            .targets([tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(diagnostics::LOG_NAME.into()),
            })])
            .filter(|metadata| matches!(metadata.target(), "script_ai" | "script_store"))
            .max_file_size(5 * 1024 * 1024)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(4))
            .build())
        .manage(ai::AiState::default())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let _ = ytdlp::APP.set(app.handle().clone());
            let appdata = app.path().data_dir().map_err(|e| e.to_string())?;
            let root = store::pick_root(appdata);
            store::migrate_from_exe_dir(&root);
            store::init(root);
            #[cfg(target_os = "macos")]
            app.manage(youtube_embed::EmbedAddress::start()?);
            // Ana pencere koddan kurulur: gömülü YouTube videosunun açmak istediği yeni pencereler
            // (başlık, logo, "YouTube'da izle") uygulama içinde engellenmek yerine tarayıcıda açılır.
            let conf = app.config().app.windows.first().cloned().ok_or("pencere ayarı yok")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &conf)?
                .on_new_window(|url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = external::open_external(url.to_string());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                // Senaryo ses kayıtları için mikrofon izni (yalnızca kendi arayüzümüz istiyor).
                .on_permission_request(|_, kind| match kind {
                    tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
                    _ => tauri::webview::PermissionResponse::Default,
                })
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects::list_projects,
            projects::create_project,
            projects::load_project,
            projects::save_project,
            projects::delete_project,
            projects::clear_all_projects,
            projects::patch_project,
            backups::list_backups,
            backups::restore_backup,
            diagnostics::export_diagnostics,
            updates::automatic_update_supported,
            updates::check_manual_update,
            videos::refresh_video_stats,
            videos::load_video_stats,
            videos::test_youtube_key,
            settings::has_youtube_key,
            settings::set_youtube_key,
            images::save_image,
            images::read_image,
            images::delete_image,
            settings::load_settings,
            settings::save_settings,
            settings::has_api_key,
            settings::set_api_key,
            settings::has_groq_key,
            settings::set_groq_key,
            stt::transcribe_media,
            stt::transcribe_audio,
            whisper::whisper_status,
            whisper::whisper_download,
            whisper::whisper_cancel_download,
            whisper::whisper_delete_model,
            whisper::whisper_download_cuda,
            whisper::whisper_delete_cuda,
            transcript::list_subtitles,
            transcript::fetch_transcript,
            transcript::fetch_default_transcript,
            ai::list_models,
            ai::ai_stream,
            ai::ai_cancel,
            codex::codex_status,
            tts::tts,
            transcript::video_meta,
            transcript::video_stream_url,
            #[cfg(target_os = "macos")]
            youtube_embed::youtube_embed_base,
            external::open_external,
            export::save_text_file,
            voice::save_voice_take,
            voice::read_voice_take,
            voice::delete_voice_take,
            voice::prune_voice_takes,
            voice::export_voice_takes,
            voice::save_binary_file,
        ])
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}

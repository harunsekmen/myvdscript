mod commands;
mod http;
mod store;
mod ytdlp;

use commands::{ai, export, external, images, projects, settings, stt, transcript, tts, videos};
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
        .manage(ai::AiState::default())
        .setup(|app| {
            let _ = ytdlp::APP.set(app.handle().clone());
            let appdata = app.path().data_dir().map_err(|e| e.to_string())?;
            let root = store::pick_root(appdata);
            store::migrate_from_exe_dir(&root);
            store::init(root);
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
            transcript::list_subtitles,
            transcript::fetch_transcript,
            transcript::fetch_default_transcript,
            ai::list_models,
            ai::ai_stream,
            ai::ai_cancel,
            tts::tts,
            transcript::video_meta,
            transcript::video_stream_url,
            external::open_external,
            export::save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}

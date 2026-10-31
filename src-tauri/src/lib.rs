mod commands;
mod store;
mod ytdlp;

use commands::{ai, images, projects, settings, stt, transcript, tts};
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
            let appdata = app.path().data_dir().map_err(|e| e.to_string())?;
            store::init(store::pick_root(appdata));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects::list_projects,
            projects::create_project,
            projects::load_project,
            projects::save_project,
            projects::delete_project,
            projects::clear_all_projects,
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
            transcript::fetch_transcript,
            ai::list_models,
            ai::ai_stream,
            ai::ai_cancel,
            tts::tts,
        ])
        .run(tauri::generate_context!())
        .expect("uygulama başlatılamadı");
}

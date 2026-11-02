// Prevents additional console window on Windows in release
#[cfg_attr(not(mobile), windows_subsystem = "windows")]

#[tauri::command]
pub async fn sc_client_id() -> Result<String, String> {
    soundcloud::get_client_id().await
}

#[tauri::command]
pub async fn sc_search(q: String, limit: Option<i64>) -> Result<Vec<soundcloud::TrackDto>, String> {
    soundcloud::search_tracks(&q, limit.unwrap_or(30)).await
}

#[tauri::command]
pub async fn sc_play_track(trackId: i64) -> Result<soundcloud::TrackDto, String> {
    soundcloud::play_track(trackId).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::default().build())
        .invoke_handler(tauri::generate_handler![sc_client_id, sc_search, sc_play_track])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Prevents additional console window on Windows in release
#[cfg_attr(not(mobile), windows_subsystem = "windows")]

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::default().build())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

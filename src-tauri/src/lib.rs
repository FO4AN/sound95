mod audio;
mod client;
mod discord;
mod login;
mod lyrics;
mod store;
mod tray;
mod update;
mod visual;

use client::{AppError, Client};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use url::Url;

const RETRY_AFTER: Duration = Duration::from_millis(600);

struct App {
    client: Client,
    /// Requests fail together when a session expires, but one renewal will do.
    renewing: Mutex<()>,
}

#[derive(Serialize)]
struct Status {
    logged_on: bool,
}

fn open_https(app: &tauri::AppHandle, url: &str) -> Result<(), AppError> {
    let parsed = Url::parse(url).map_err(|_| AppError::new("bad_request", "Invalid link."))?;
    if cfg!(debug_assertions) && std::env::var_os("SOUND95_NO_BROWSER").is_some() {
        eprintln!("SOUND95_OPEN {url}");
        return Ok(());
    }
    if parsed.scheme() != "https" {
        return Err(AppError::new(
            "bad_request",
            "Only https links can be opened.",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::new("browser", format!("Could not open your browser: {e}")))
}

#[tauri::command]
async fn status(app: State<'_, App>) -> Result<Status, AppError> {
    Ok(Status {
        logged_on: app.client.snapshot().await.user.is_some(),
    })
}

#[tauri::command]
async fn login(app: State<'_, App>, handle: tauri::AppHandle) -> Result<(), AppError> {
    let token = login::sign_in(&handle).await?;
    app.client.set_session(token).await
}

#[tauri::command]
fn cancel_login(handle: tauri::AppHandle) {
    login::cancel(&handle);
}

#[tauri::command]
async fn logout(app: State<'_, App>, handle: tauri::AppHandle) -> Result<(), AppError> {
    login::forget(&handle);
    app.client.logout().await
}

async fn renew(app: &App, handle: &AppHandle, rejected: &str) -> Result<(), AppError> {
    let _one_at_a_time = app.renewing.lock().await;
    if app.client.access_token().await? != rejected {
        return Ok(());
    }
    match login::renew(handle, rejected).await {
        Some(token) => app.client.set_session(token).await,
        // Quitting during a renewal shouldn't cost the login.
        None if handle.get_webview_window("main").is_none() => Err(client::expired()),
        None => {
            app.client.logout().await?;
            Err(client::expired())
        }
    }
}

/// Sends a request, renewing the session once if SoundCloud turns it down.
async fn call(
    app: &App,
    handle: &AppHandle,
    method: Method,
    url: Url,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let sent = app.client.access_token().await?;
    let attempt = || {
        app.client
            .request(method.clone(), url.clone(), body.clone())
    };
    let mut first = attempt().await;
    // Only reads: a write that timed out may still have gone through.
    if method == Method::GET && first.as_ref().is_err_and(AppError::is_transient) {
        tokio::time::sleep(RETRY_AFTER).await;
        first = attempt().await;
    }
    match first {
        Err(e) if e.code == "unauthorized" => renew(app, handle, &sent).await?,
        result => return result,
    }
    match attempt().await {
        Err(e) if e.code == "unauthorized" => {
            app.client.logout().await?;
            Err(client::expired())
        }
        result => result,
    }
}

#[tauri::command]
async fn api_get(
    app: State<'_, App>,
    handle: AppHandle,
    target: String,
) -> Result<Value, AppError> {
    let url = app.client.api_url(&target)?;
    call(&app, &handle, Method::GET, url, None).await
}

#[tauri::command]
async fn api_send(
    app: State<'_, App>,
    handle: AppHandle,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, AppError> {
    if !client::write_allowed(&method, &path) {
        return Err(AppError::new(
            "bad_request",
            format!("{method} {path} is not allowed."),
        ));
    }
    let method = Method::from_bytes(method.as_bytes())
        .map_err(|_| AppError::new("bad_request", "Bad method."))?;
    let url = app.client.api_url(&path)?;
    call(&app, &handle, method, url, body).await
}

#[tauri::command]
fn open_link(handle: tauri::AppHandle, url: String) -> Result<(), AppError> {
    open_https(&handle, &url)
}

// Async, because creating a window in a synchronous command deadlocks on Windows.
#[tauri::command]
async fn open_track_page(handle: AppHandle, link: String) -> Result<(), AppError> {
    login::open_track_page(&handle, &link)
}

#[tauri::command]
fn track_page_open(handle: AppHandle) -> bool {
    login::track_page_open(&handle)
}

#[tauri::command]
fn close_track_page(handle: AppHandle) {
    login::close_track_page(&handle);
}

#[tauri::command]
async fn lyrics_search(request: lyrics::Request) -> Result<Vec<lyrics::Lyrics>, AppError> {
    lyrics::search(request).await
}

#[tauri::command]
async fn waveform(app: State<'_, App>, url: String) -> Result<Value, AppError> {
    app.client.waveform(&url).await
}

#[tauri::command]
fn visual_start(visual: State<'_, visual::Visual>, handle: AppHandle) -> bool {
    visual.start(handle)
}

#[tauri::command]
fn visual_stop(visual: State<'_, visual::Visual>) {
    visual.stop();
}

#[tauri::command]
async fn update_check(
    handle: AppHandle,
    pending: State<'_, update::Pending>,
) -> Result<Option<update::Available>, AppError> {
    update::check(&handle, &pending).await
}

#[tauri::command]
async fn update_install(
    handle: AppHandle,
    pending: State<'_, update::Pending>,
) -> Result<(), AppError> {
    update::install(&handle, &pending).await
}

#[tauri::command]
async fn audio_status() -> Result<audio::AudioStatus, AppError> {
    tauri::async_runtime::spawn_blocking(audio::status)
        .await
        .map_err(|e| AppError::new("audio_install", e.to_string()))
}

#[tauri::command]
async fn audio_install() -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(audio::install)
        .await
        .map_err(|e| AppError::new("audio_install", e.to_string()))?
}

#[tauri::command]
fn tray_update(handle: AppHandle, labels: tray::Labels) -> Result<(), AppError> {
    let Some(tray) = handle.try_state::<tray::Tray>() else {
        return Ok(());
    };
    tray.update(&labels)
        .map_err(|e| AppError::new("tray", e.to_string()))
}

#[tauri::command]
fn tray_closes_to(handle: AppHandle, closes: bool) {
    if let Some(tray) = handle.try_state::<tray::Tray>() {
        tray.set_closes_to_tray(closes);
    }
}

#[tauri::command]
fn discord_available() -> bool {
    discord::Discord::available()
}

#[tauri::command]
fn discord_update(
    discord: State<'_, discord::Discord>,
    enabled: bool,
    playing: Option<discord::Playing>,
) {
    discord.update(enabled, playing);
}

#[tauri::command]
fn quit(handle: AppHandle) {
    handle.exit(0);
}

/// WebKit reads the GStreamer registry once at startup, so new plug-ins need a
/// fresh process.
#[tauri::command]
fn relaunch(handle: tauri::AppHandle) {
    handle.restart();
}

pub fn run() {
    // WebKitGTK ranks its HLS demuxers out unless this is set, and SoundCloud
    // serves tracks as HLS. Must happen before the webview starts.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_GST_ENABLE_HLS_SUPPORT").is_none() {
        std::env::set_var("WEBKIT_GST_ENABLE_HLS_SUPPORT", "1");
    }

    let builder = tauri::Builder::default();
    // Runs tools/e2e.js in the real webview. Compiled out of release builds.
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(|webview, payload| {
        let finished = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
        if finished && webview.label() == "main" {
            if let Some(script) =
                std::env::var_os("SOUND95_E2E").and_then(|p| std::fs::read_to_string(p).ok())
            {
                let _ = webview.eval(script);
            }
        }
    });
    // Starting Sound95 while it sits in the tray brings the window back. Not in
    // debug builds, so tests can run next to a copy that's in use.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        tray::show(app);
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    let tray = window.try_state::<tray::Tray>();
                    if tray.is_some_and(|tray| tray.closes_to_tray()) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                WindowEvent::Destroyed => {
                    login::close_all(window.app_handle());
                    window.state::<visual::Visual>().stop();
                    window.state::<discord::Discord>().update(false, None);
                }
                _ => {}
            }
        })
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let client = Client::new(dir.join("session.json"));
            app.manage(App {
                client,
                renewing: Mutex::new(()),
            });
            app.manage(visual::Visual::default());
            app.manage(update::Pending::default());
            app.manage(discord::Discord::default());
            // On Linux this panics when the system has no tray library. Sound95 is
            // fine without a tray, and closing the window then just quits.
            match catch_unwind(AssertUnwindSafe(|| tray::build(app))) {
                Ok(Ok(tray)) => {
                    app.manage(tray);
                }
                Ok(Err(e)) => eprintln!("No tray icon: {e}"),
                Err(_) => eprintln!("No tray icon: the tray library is missing"),
            }
            // Not on Linux: a tiling compositor scales a window that wants more
            // than its tile, and the pointer stops lining up with the page.
            #[cfg(not(target_os = "linux"))]
            if let Some(window) = app.get_webview_window("main") {
                window.set_min_size(Some(tauri::LogicalSize::new(480.0, 360.0)))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            login,
            cancel_login,
            logout,
            api_get,
            api_send,
            open_link,
            open_track_page,
            track_page_open,
            close_track_page,
            lyrics_search,
            waveform,
            visual_start,
            visual_stop,
            update_check,
            update_install,
            audio_status,
            audio_install,
            tray_update,
            tray_closes_to,
            discord_available,
            discord_update,
            quit,
            relaunch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sound95");
}

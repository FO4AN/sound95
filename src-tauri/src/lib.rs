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
use store::Token;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use url::Url;

const RETRY_AFTER: Duration = Duration::from_millis(600);

struct App {
    client: Client,
    /// Requests fail together when a session expires, but one renewal will do.
    renewing: Mutex<()>,
    /// Held to check the stored session and change it in one step, so a renewal
    /// that finishes late can't undo a Log Off.
    changing: Mutex<()>,
}

impl App {
    fn new(client: Client) -> Self {
        Self {
            client,
            renewing: Mutex::new(()),
            changing: Mutex::new(()),
        }
    }

    /// Replaces the stored session only if it's still `expected`. False means
    /// something else changed it first.
    async fn replace_session(
        &self,
        expected: &str,
        token: Option<Token>,
    ) -> Result<bool, AppError> {
        let _changing = self.changing.lock().await;
        if self.client.access_token().await.ok().as_deref() != Some(expected) {
            return Ok(false);
        }
        match token {
            Some(token) => self.client.set_session(token).await?,
            None => self.client.logout().await?,
        }
        Ok(true)
    }
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
    // A session that's still held wasn't turned down, so the cookie that renews it stays.
    let rejected = app.client.snapshot().await.user.is_none();
    let token = login::sign_in(&handle, rejected).await?;
    let _changing = app.changing.lock().await;
    app.client.set_session(token).await
}

#[tauri::command]
fn cancel_login(handle: tauri::AppHandle) {
    login::cancel(&handle);
}

#[tauri::command]
async fn logout(app: State<'_, App>, handle: tauri::AppHandle) -> Result<(), AppError> {
    // The hidden renewal goes first, or a page it's still loading could set
    // the cookies again after they're cleared.
    login::close_all(&handle);
    login::forget(&handle);
    let _changing = app.changing.lock().await;
    app.client.logout().await
}

async fn renew(app: &App, handle: &AppHandle, rejected: &str) -> Result<(), AppError> {
    let _one_at_a_time = app.renewing.lock().await;
    if app.client.access_token().await? != rejected {
        return Ok(());
    }
    let renewed = login::renew(handle, rejected).await;
    // Quitting during a renewal shouldn't cost the login.
    if renewed.is_none() && handle.get_webview_window("main").is_none() {
        return Err(client::expired());
    }
    // A Log Off or a new sign-in while this ran wins, and the caller then
    // tries again with whatever is stored now.
    let expired = renewed.is_none();
    if app.replace_session(rejected, renewed).await? && expired {
        return Err(client::expired());
    }
    Ok(())
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
    let renewed = app.client.access_token().await?;
    match attempt().await {
        Err(e) if e.code == "unauthorized" => {
            app.replace_session(&renewed, None).await?;
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

/// Where an AppImage keeps its GStreamer registry, unless the user chose. Its
/// plug-ins sit at a new mount point every launch, so GStreamer scans them all
/// again each time, and by default saves the result over the registry that
/// every other GStreamer program shares, which they then have to rebuild.
#[cfg(target_os = "linux")]
fn appimage_registry(
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    var("APPIMAGE")?;
    if var("GST_REGISTRY_1_0").is_some() || var("GST_REGISTRY").is_some() {
        return None;
    }
    let cache = var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| var("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
    Some(
        cache
            .join("com.fo4an.sound95")
            .join("gstreamer-registry.bin"),
    )
}

pub fn run() {
    // WebKitGTK ranks its HLS demuxers out unless this is set, and SoundCloud
    // serves tracks as HLS. Must happen before the webview starts.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_GST_ENABLE_HLS_SUPPORT").is_none() {
        std::env::set_var("WEBKIT_GST_ENABLE_HLS_SUPPORT", "1");
    }
    #[cfg(target_os = "linux")]
    if let Some(registry) = appimage_registry(|name| std::env::var_os(name)) {
        std::env::set_var("GST_REGISTRY_1_0", registry);
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
                    // With no tray on screen, closing quits as it does without one.
                    if tray.is_some_and(|tray| tray.closes_to_tray()) && tray::host_present() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                WindowEvent::Destroyed => {
                    login::close_all(window.app_handle());
                    window.state::<visual::Visual>().stop();
                    window.state::<discord::Discord>().shutdown();
                }
                _ => {}
            }
        })
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let client = Client::new(dir.join("session.json"));
            app.manage(App::new(client));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> (App, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("sound95-lib-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (App::new(Client::new(dir.join("session.json"))), dir)
    }

    fn token(access: &str) -> Token {
        Token {
            access: access.into(),
        }
    }

    #[tokio::test]
    async fn a_late_renewal_cannot_undo_a_log_off() {
        let (app, dir) = app("late-renewal");
        app.client.set_session(token("old")).await.unwrap();
        app.client.logout().await.unwrap();
        assert!(!app
            .replace_session("old", Some(token("new")))
            .await
            .unwrap());
        assert!(app.client.snapshot().await.user.is_none());
        assert!(store::Store::load(&dir.join("session.json")).user.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_appimage_keeps_its_gstreamer_registry_apart() {
        let env = |vars: &'static [(&str, &str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.into())
            }
        };
        let ours = std::path::Path::new("/home/a/.cache/com.fo4an.sound95/gstreamer-registry.bin");
        let appimage = env(&[("APPIMAGE", "/x/Sound95.AppImage"), ("HOME", "/home/a")]);
        assert_eq!(appimage_registry(appimage).as_deref(), Some(ours));
        let cache = env(&[("APPIMAGE", "/x"), ("XDG_CACHE_HOME", "/home/a/.cache")]);
        assert_eq!(appimage_registry(cache).as_deref(), Some(ours));
        // A relative XDG_CACHE_HOME is to be ignored.
        let relative = env(&[
            ("APPIMAGE", "/x"),
            ("XDG_CACHE_HOME", "c"),
            ("HOME", "/home/a"),
        ]);
        assert_eq!(appimage_registry(relative).as_deref(), Some(ours));
        // Installed from the .deb, and when the user picked a registry, it's left alone.
        assert_eq!(appimage_registry(env(&[("HOME", "/home/a")])), None);
        let chosen = env(&[("APPIMAGE", "/x"), ("HOME", "/h"), ("GST_REGISTRY", "/r")]);
        assert_eq!(appimage_registry(chosen), None);
    }

    #[tokio::test]
    async fn only_the_turned_down_session_is_replaced() {
        let (app, dir) = app("replace");
        app.client.set_session(token("old")).await.unwrap();
        assert!(app
            .replace_session("old", Some(token("new")))
            .await
            .unwrap());
        assert_eq!(app.client.access_token().await.unwrap(), "new");
        // A second account signed in meanwhile stays signed in.
        assert!(!app.replace_session("old", None).await.unwrap());
        assert_eq!(app.client.access_token().await.unwrap(), "new");
        assert!(app.replace_session("new", None).await.unwrap());
        assert!(app.client.snapshot().await.user.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

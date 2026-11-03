//! Logs in on SoundCloud's own sign-in page, in a window of its own. The page
//! can't call the app (only the bundled UI can), and the session it leaves in
//! the `oauth_token` cookie is all the API needs, so nothing has to be set up.
//!
//! That session lasts about a day. The sign-in also leaves a long-lived refresh
//! cookie, and any page load that carries it gets a new session from the
//! website's server, so `renew` just loads a page where nobody can see it.

use crate::client::AppError;
use crate::store::Token;
use std::time::{Duration, Instant};
use tauri::{
    webview::{Cookie, NewWindowResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use url::Url;

const WINDOW: &str = "login";
const RENEW_WINDOW: &str = "renew";
const PAGE_WINDOW: &str = "track-page";
const SITE: &str = "soundcloud.com";
const SIGN_IN_URL: &str = "https://soundcloud.com/signin";
const RENEW_URL: &str = "https://soundcloud.com/";
const SESSION_COOKIE: &str = "oauth_token";
const POLL: Duration = Duration::from_millis(400);
const RENEW_TIMEOUT: Duration = Duration::from_secs(20);
/// SoundCloud's pages can start playing as they load, which would sound over
/// Sound95 and count as a play. These windows are never there for the audio, so
/// `play` fails the way it does when a browser blocks autoplay.
const NO_PLAYBACK: &str = "HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Playback is off in this window.', 'NotAllowedError'));\
document.addEventListener('play', (e) => e.target.pause(), true);";

#[cfg_attr(not(debug_assertions), allow(unused_variables))]
fn page_url(real: &str, override_var: &str) -> Url {
    // Lets the mock server in tools/ stand in for the real pages. Compiled out
    // of release builds.
    #[cfg(debug_assertions)]
    if let Some(url) = std::env::var(override_var)
        .ok()
        .and_then(|u| Url::parse(&u).ok())
    {
        return url;
    }
    Url::parse(real).expect("page URL is valid")
}

fn sign_in_url() -> Url {
    page_url(SIGN_IN_URL, "SOUND95_SIGNIN_URL")
}

fn on_site(domain: &str, host: &str) -> bool {
    let domain = domain.trim_start_matches('.');
    domain == host || domain.ends_with(&format!(".{host}"))
}

/// The sign-in site's cookies. Not `cookies_for_url`, which panics if the
/// window closes during the call.
fn site_cookies(window: &WebviewWindow) -> Vec<Cookie<'static>> {
    let url = sign_in_url();
    let host = url.host_str().unwrap_or_default();
    let cookies = window.cookies().unwrap_or_default();
    cookies
        .into_iter()
        .filter(|c| on_site(c.domain().unwrap_or_default(), host))
        .collect()
}

fn session(window: &WebviewWindow) -> Option<String> {
    site_cookies(window)
        .into_iter()
        .find(|c| c.name() == SESSION_COOKIE && !c.value().is_empty())
        .map(|c| c.value().to_string())
}

/// Opens the sign-in window and waits for the session, or for the window to
/// be closed.
pub async fn sign_in(handle: &AppHandle) -> Result<Token, AppError> {
    cancel(handle);
    // A session the API turned down would otherwise log straight back in.
    if let Some(main) = handle.get_webview_window("main") {
        for cookie in site_cookies(&main) {
            let _ = main.delete_cookie(cookie);
        }
    }
    let page = WebviewUrl::External(sign_in_url());
    let mut builder = WebviewWindowBuilder::new(handle, WINDOW, page)
        .title("Log In to SoundCloud")
        .inner_size(1000.0, 760.0)
        // Google and Apple sign-in open in pop-ups.
        .on_new_window(|_, _| NewWindowResponse::Allow);
    if let Some(main) = handle.get_webview_window("main") {
        builder = builder.parent(&main).map_err(window_err)?;
    }
    let window = builder.build().map_err(window_err)?;
    loop {
        tokio::time::sleep(POLL).await;
        if handle.get_webview_window(WINDOW).is_none() {
            return Err(AppError::new("login_cancelled", "Login cancelled."));
        }
        if let Some(access) = session(&window) {
            let _ = window.destroy();
            return Ok(Token { access });
        }
    }
}

/// Gets a new session without showing anything. None means the website wants
/// a real sign-in.
pub async fn renew(handle: &AppHandle, rejected: &str) -> Option<Token> {
    let main = handle.get_webview_window("main")?;
    // The server only hands out a session to a visitor without one.
    for cookie in site_cookies(&main) {
        if cookie.name() == SESSION_COOKIE {
            let _ = main.delete_cookie(cookie);
        }
    }
    let page = WebviewUrl::External(page_url(RENEW_URL, "SOUND95_RENEW_URL"));
    let window = WebviewWindowBuilder::new(handle, RENEW_WINDOW, page)
        .initialization_script(NO_PLAYBACK)
        .visible(false)
        .build()
        .ok()?;
    let started = Instant::now();
    let mut access = None;
    while access.is_none() && started.elapsed() < RENEW_TIMEOUT {
        tokio::time::sleep(POLL).await;
        handle.get_webview_window(RENEW_WINDOW)?;
        access = session(&window).filter(|s| s != rejected);
    }
    let _ = window.destroy();
    access.map(|access| Token { access })
}

/// Shows a track's real SoundCloud page, signed in, for its Like button. SoundCloud's
/// bot check turns away likes sent by an app, but a person on its own page is fine.
/// The page can't call the app, like the sign-in page.
pub fn open_track_page(handle: &AppHandle, link: &str) -> Result<(), AppError> {
    let bad = || AppError::new("bad_request", "Not a SoundCloud page.");
    let url = Url::parse(link).map_err(|_| bad())?;
    if url.scheme() != "https" || !on_site(url.host_str().unwrap_or_default(), SITE) {
        return Err(bad());
    }
    let url = page_url(url.as_str(), "SOUND95_TRACK_PAGE");
    if let Some(window) = handle.get_webview_window(PAGE_WINDOW) {
        window.navigate(url).map_err(window_err)?;
        return window.set_focus().map_err(window_err);
    }
    let mut builder = WebviewWindowBuilder::new(handle, PAGE_WINDOW, WebviewUrl::External(url))
        .initialization_script(NO_PLAYBACK)
        .title("SoundCloud")
        .inner_size(980.0, 720.0);
    if let Some(main) = handle.get_webview_window("main") {
        builder = builder.parent(&main).map_err(window_err)?;
    }
    builder.build().map_err(window_err)?;
    Ok(())
}

pub fn track_page_open(handle: &AppHandle) -> bool {
    handle.get_webview_window(PAGE_WINDOW).is_some()
}

pub fn close_track_page(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window(PAGE_WINDOW) {
        let _ = window.destroy();
    }
}

fn window_err(e: tauri::Error) -> AppError {
    AppError::new(
        "login_window",
        format!("Could not open the SoundCloud window: {e}"),
    )
}

pub fn cancel(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window(WINDOW) {
        let _ = window.destroy();
    }
}

/// Closes the windows that would otherwise outlive the main one.
pub fn close_all(handle: &AppHandle) {
    cancel(handle);
    close_track_page(handle);
    if let Some(window) = handle.get_webview_window(RENEW_WINDOW) {
        let _ = window.destroy();
    }
}

/// Removes every cookie a sign-in left behind, Google's and Apple's included.
pub fn forget(handle: &AppHandle) {
    let Some(main) = handle.get_webview_window("main") else {
        return;
    };
    for cookie in main.cookies().unwrap_or_default() {
        let _ = main.delete_cookie(cookie);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_sign_in_site_counts() {
        assert!(on_site("soundcloud.com", "soundcloud.com"));
        assert!(on_site(".soundcloud.com", "soundcloud.com"));
        assert!(on_site("secure.soundcloud.com", "soundcloud.com"));
        assert!(!on_site("evilsoundcloud.com", "soundcloud.com"));
        assert!(!on_site("soundcloud.com.evil.example", "soundcloud.com"));
        assert!(!on_site("", "soundcloud.com"));
    }

    #[test]
    fn only_soundcloud_pages_open() {
        let refused = |link: &str| {
            let url = Url::parse(link).unwrap();
            url.scheme() != "https" || !on_site(url.host_str().unwrap_or_default(), SITE)
        };
        assert!(!refused("https://soundcloud.com/xight/hello"));
        assert!(refused("http://soundcloud.com/xight/hello"));
        assert!(refused("https://soundcloud.com.evil.example/xight"));
        assert!(refused("javascript:alert(1)"));
    }
}

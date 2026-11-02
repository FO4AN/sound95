//! SoundCloud API client. Owns the session: the webview only sees JSON results.

use crate::store::{Store, Token};
use reqwest::{header, Method, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio::sync::Mutex;
use url::Url;

#[derive(Clone, Debug, Serialize)]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
}

impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after: None,
        }
    }
}

fn net_err(e: reqwest::Error) -> AppError {
    AppError::new("network", format!("Could not reach SoundCloud: {e}"))
}

pub fn expired() -> AppError {
    AppError::new(
        "session_expired",
        "Your session has expired. Please log in again.",
    )
}

fn api_base() -> String {
    // Lets the mock server in tools/ stand in for the real one. Compiled out of
    // release builds, so nothing can redirect a real user's session.
    #[cfg(debug_assertions)]
    if let Ok(api) = std::env::var("SOUND95_API_BASE") {
        return api;
    }
    // The website's API, because that's the one a website login is good for.
    // api.soundcloud.com answers these sessions with 403.
    "https://api-v2.soundcloud.com".into()
}

const WAVE_HOST: &str = "wave.sndcdn.com";

pub struct Client {
    pub http: reqwest::Client,
    api: String,
    path: PathBuf,
    store: Mutex<Store>,
}

/// Mutations the app performs. Everything else is refused.
pub fn write_allowed(method: &str, path: &str) -> bool {
    let id = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let segments: Vec<&str> = path.split('/').collect();
    match (method, segments.as_slice()) {
        ("PUT" | "DELETE", ["", "users", user, "track_likes", track]) => id(user) && id(track),
        ("POST" | "DELETE", ["", "me", "followings", user]) => id(user),
        ("POST", ["", "playlists"]) => true,
        ("PUT", ["", "playlists", playlist]) => id(playlist),
        _ => false,
    }
}

impl Client {
    pub fn new(path: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("Sound95/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        let store = Store::load(&path);
        Self {
            http,
            api: api_base(),
            path,
            store: Mutex::new(store),
        }
    }

    fn persist(&self, store: &Store) -> Result<(), AppError> {
        store
            .save(&self.path)
            .map_err(|e| AppError::new("storage", format!("Could not save session: {e}")))
    }

    pub async fn snapshot(&self) -> Store {
        self.store.lock().await.clone()
    }

    pub async fn set_session(&self, token: Token) -> Result<(), AppError> {
        let mut store = self.store.lock().await;
        store.user = Some(token);
        self.persist(&store)
    }

    /// The token of the logged-in user.
    pub async fn access_token(&self) -> Result<String, AppError> {
        let store = self.store.lock().await;
        store
            .user
            .as_ref()
            .map(|t| t.access.clone())
            .ok_or_else(|| AppError::new("not_logged_on", "Log in to SoundCloud first."))
    }

    /// Accepts an API path, or a `next_href` from a previous response. Refuses
    /// anything off the API origin so a token can never be sent elsewhere.
    pub fn api_url(&self, target: &str) -> Result<Url, AppError> {
        let base = Url::parse(&self.api).expect("api base is a URL");
        let bad = || {
            AppError::new(
                "bad_request",
                "Refused a request outside the SoundCloud API.",
            )
        };
        let url = if target.starts_with('/') && !target.starts_with("//") {
            base.join(target).map_err(|_| bad())?
        } else {
            Url::parse(target).map_err(|_| bad())?
        };
        if url.origin() != base.origin() {
            return Err(bad());
        }
        Ok(url)
    }

    /// Fetches a track's waveform, which lives on its own host and needs no session.
    pub async fn waveform(&self, target: &str) -> Result<Value, AppError> {
        let bad = || AppError::new("bad_request", "Refused a waveform from another host.");
        // Older tracks link a picture of the waveform, with the data beside it.
        let url = Url::parse(&target.replace(".png", ".json")).map_err(|_| bad())?;
        let allowed = url.scheme() == "https" && url.host_str() == Some(WAVE_HOST);
        if !allowed && !self.is_mock(&url) {
            return Err(bad());
        }
        let bytes = self
            .http
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(net_err)?
            .bytes()
            .await
            .map_err(net_err)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| AppError::new("http", format!("Unreadable waveform: {e}")))
    }

    fn is_mock(&self, url: &Url) -> bool {
        cfg!(debug_assertions)
            && std::env::var_os("SOUND95_API_BASE").is_some()
            && Url::parse(&self.api).is_ok_and(|base| base.origin() == url.origin())
    }

    pub async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
    ) -> Result<Value, AppError> {
        let token = self.access_token().await?;
        let mut req = self
            .http
            .request(method, url)
            .header(header::AUTHORIZATION, format!("OAuth {token}"))
            .header(header::ACCEPT, "application/json; charset=utf-8")
            .timeout(Duration::from_secs(20));
        if let Some(body) = &body {
            req = req.json(body);
        }
        let resp = req.send().await.map_err(net_err)?;
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(AppError::new("unauthorized", expired().message));
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            let retry_after = resp
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok());
            let mut err = AppError::new("rate_limited", "SoundCloud rate limit reached.");
            err.retry_after = retry_after;
            return Err(err);
        }
        if !status.is_success() {
            let code = match status {
                StatusCode::NOT_FOUND => "not_found",
                StatusCode::FORBIDDEN => "forbidden",
                _ => "http",
            };
            return Err(AppError::new(code, format!("SoundCloud returned {status}")));
        }
        let bytes = resp.bytes().await.map_err(net_err)?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|e| AppError::new("http", format!("Unreadable response: {e}")))
    }

    pub async fn logout(&self) -> Result<(), AppError> {
        let mut store = self.store.lock().await;
        store.user = None;
        self.persist(&store)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> Client {
        Client::new(PathBuf::from("/nonexistent/sound95/session.json"))
    }

    #[test]
    fn api_url_stays_on_origin() {
        let c = client();
        assert!(c.api_url("/me/track_likes/ids?limit=5").is_ok());
        assert!(c
            .api_url("https://api-v2.soundcloud.com/search/tracks?offset=2")
            .is_ok());
        assert!(c.api_url("https://evil.example/tracks").is_err());
        assert!(c.api_url("//evil.example/tracks").is_err());
        assert!(c.api_url("http://api-v2.soundcloud.com/tracks").is_err());
        assert!(c
            .api_url("https://api-v2.soundcloud.com.evil.example/")
            .is_err());
    }

    #[test]
    fn writes_are_allowlisted() {
        assert!(write_allowed("PUT", "/users/9/track_likes/1"));
        assert!(write_allowed("DELETE", "/users/9/track_likes/1"));
        assert!(write_allowed("POST", "/me/followings/1"));
        assert!(write_allowed("DELETE", "/me/followings/1"));
        assert!(write_allowed("POST", "/playlists"));
        assert!(write_allowed("PUT", "/playlists/1"));
        assert!(!write_allowed("DELETE", "/playlists/1"));
        assert!(!write_allowed("DELETE", "/tracks/1"));
        assert!(!write_allowed("PUT", "/users/9/track_likes/"));
        assert!(!write_allowed("PUT", "/users/9/track_likes/1/../../tracks"));
        assert!(!write_allowed("PUT", "/users/me/track_likes/1"));
        assert!(!write_allowed("POST", "/me/followings/1?x=1"));
        assert!(!write_allowed("GET", "/me"));
    }

    #[tokio::test]
    async fn waveforms_only_come_from_soundcloud() {
        let c = client();
        for bad in [
            "https://evil.example/w.json",
            "http://wave.sndcdn.com/w.json",
            "https://wave.sndcdn.com.evil.example/w.json",
            "file:///etc/passwd",
        ] {
            assert_eq!(c.waveform(bad).await.unwrap_err().code, "bad_request");
        }
    }

    #[tokio::test]
    async fn logged_out_requests_ask_for_logon() {
        assert_eq!(
            client().access_token().await.unwrap_err().code,
            "not_logged_on"
        );
    }
}

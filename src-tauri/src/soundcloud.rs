use regex::Regex;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const SC_BASE_URL: &str = "https://soundcloud.com";
const SC_API_V2: &str = "https://api-v2.soundcloud.com";
const SC_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

fn client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("failed to build reqwest client")
}

async fn get_json<T: serde::de::DeserializeOwned>(client: &Client, url: &str) -> Result<T, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if status != StatusCode::OK {
        return Err(format!("HTTP {status}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("json decode: {e}"))
}

pub async fn get_client_id() -> Result<String, String> {
    let client = client();
    let resp = client
        .get(SC_BASE_URL)
        .header(reqwest::header::USER_AGENT, SC_USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("sc home: {e}"))?;
    let bytes = resp.bytes().await.map_err(|e| format!("sc home body: {e}"))?;
    let html = String::from_utf8_lossy(&bytes).to_string();
    let re = Regex::new(
        r#""hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)""#,
    )
    .map_err(|e| e.to_string())?;
    let caps = re
        .captures(&html)
        .ok_or_else(|| "client_id not found".to_string())?;
    Ok(caps
        .get(1)
        .ok_or_else(|| "client_id capture missing".to_string())?
        .as_str()
        .to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transcoding {
    pub url: String,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub snipped: Option<bool>,
    #[serde(rename = "format", default)]
    pub format_field: Option<Format>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Format {
    pub protocol: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackDto {
    pub id: i64,
    #[serde(default)]
    pub urn: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub artwork: Option<String>,
    #[serde(default)]
    pub transcodings: Option<Vec<Transcoding>>,
    #[serde(default)]
    pub track_authorization: Option<String>,
    #[serde(default)]
    pub stream_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Media {
    #[serde(default)]
    pub transcodings: Option<Vec<Transcoding>>,
}

#[derive(Debug, Deserialize)]
struct TrackResponse {
    #[serde(default)]
    pub media: Option<Media>,
    #[serde(default)]
    pub track_authorization: Option<String>,
    #[serde(default)]
    pub urn: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub artwork: Option<String>,
    #[serde(default)]
    pub artist_names: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSearchResponse {
    #[serde(default)]
    pub results: Vec<RawTrack>,
}

#[derive(Debug, Deserialize)]
struct RawTrack {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub urn: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub artwork_url: Option<String>,
    #[serde(default)]
    pub artist_names: Option<String>,
    #[serde(default)]
    pub media: Option<Media>,
    #[serde(default)]
    pub track_authorization: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResolveResponse {
    pub url: String,
}

fn pick_best(transcodings: &[Transcoding]) -> Option<Transcoding> {
    let presets = ["mp3_1_0", "aac_160k", "opus_0_0", "abr_sq"];
    let usable: Vec<&Transcoding> = transcodings
        .iter()
        .filter(|t| {
            let encrypted = t
                .format_field
                .as_ref()
                .and_then(|f| f.protocol.as_ref())
                .map(|p| p.to_lowercase().contains("encrypt"))
                .unwrap_or(false);
            !t.url.contains("/preview") && t.snipped != Some(true) && !encrypted
        })
        .collect();
    let is_progressive = |t: &Transcoding| {
        t.format_field
            .as_ref()
            .and_then(|f| f.protocol.as_ref())
            .map(|p| p.eq_ignore_ascii_case("progressive"))
            .unwrap_or(false)
    };
    let progressive: Vec<&Transcoding> = usable.iter().filter(|t| is_progressive(t)).copied().collect();
    let other: Vec<&Transcoding> = usable.iter().filter(|t| !is_progressive(t)).copied().collect();

    let mut out: Vec<Transcoding> = Vec::new();
    for p in presets {
        let found = progressive
            .iter()
            .find(|t| t.preset.as_deref() == Some(p))
            .cloned();
        if let Some(t) = found {
            out.push(t);
        }
    }
    for t in progressive {
        if !out.iter().any(|x| x.url == t.url) {
            out.push(t.clone());
        }
    }
    for p in presets {
        let found = other
            .iter()
            .find(|t| t.preset.as_deref() == Some(p))
            .cloned();
        if let Some(t) = found {
            out.push(t);
        }
    }
    for t in other {
        if !out.iter().any(|x| x.url == t.url) {
            out.push(t.clone());
        }
    }
    out.into_iter().next()
}

pub async fn search_tracks(q: &str, limit: i64) -> Result<Vec<TrackDto>, String> {
    let cid = get_client_id().await?;
    let client = client();
    let url = format!("{SC_API_V2}/search/tracks");
    let resp = client
        .get(&url)
        .query(&[
            ("q", q),
            ("limit", &limit),
            ("offset", &0i64),
            ("client_id", &cid),
        ])
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    let status = resp.status();
    if status != StatusCode::OK {
        return Err(format!("HTTP {status}"));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("search body: {e}"))?;
    let data: RawSearchResponse = serde_json::from_slice(&bytes)
        .map_err(|e| format!("search json: {e}"))?;
    let mut out = Vec::new();
    for r in data.results {
        out.push(TrackDto {
            id: r.id.unwrap_or(0),
            urn: r.urn,
            title: r.title,
            artist: r.artist_names,
            duration: r.duration,
            artwork: r.artwork_url,
            transcodings: r.media.and_then(|m| m.transcodings).map(|list| {
                list.into_iter()
                    .filter_map(|t| {
                        let url = t.url.clone()?;
                        Some(Transcoding {
                            url,
                            preset: t.preset,
                            snipped: t.snipped,
                            format_field: t.format_field,
                        })
                    })
                    .collect()
            }),
            track_authorization: r.track_authorization,
            stream_url: None,
        });
    }
    Ok(out)
}

pub async fn play_track(track_id: i64) -> Result<TrackDto, String> {
    let cid = get_client_id().await?;
    let client = client();
    let url = format!("{SC_API_V2}/tracks/{track_id}?client_id={cid}");
    let t: TrackResponse = get_json(&client, &url).await?;
    let transcodings = t.media.and_then(|m| m.transcodings).unwrap_or_default();
    let best = pick_best(&transcodings).ok_or_else(|| "no stream available".to_string())?;
    let sep = if best.url.contains('?') { '&' } else { '?' };
    let mut target = best.url.clone();
    target.push_str(sep);
    target.push_str("client_id=");
    target.push_str(&cid);
    if let Some(auth) = t.track_authorization.as_deref().filter(|a| !a.is_empty()) {
        target.push_str("&track_authorization=");
        target.push_str(auth);
    }
    let r: ResolveResponse = get_json(&client, &target).await?;
    Ok(TrackDto {
        id: track_id,
        urn: t.urn,
        title: t.title,
        artist: t.artist_names,
        duration: t.duration,
        artwork: t.artwork,
        transcodings: Some(vec![best]),
        track_authorization: t.track_authorization,
        stream_url: Some(r.url),
    })
}

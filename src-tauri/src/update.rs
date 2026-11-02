//! Looks for a newer release on GitHub and installs it when asked. Releases are
//! signed, so a download that doesn't match the key in tauri.conf.json is refused.

use crate::client::AppError;
use serde::Serialize;
use std::{fmt::Display, sync::Mutex};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

const PROGRESS: &str = "sound95:update";

/// The update found by the last check.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct Available {
    version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

fn failed(error: impl Display) -> AppError {
    AppError::new("update", error.to_string())
}

fn updater(handle: &AppHandle) -> Result<Updater, AppError> {
    let builder = handle.updater_builder();
    #[cfg(debug_assertions)]
    let builder = match std::env::var("SOUND95_UPDATE_URL") {
        Ok(url) => builder
            .endpoints(vec![url.parse().map_err(failed)?])
            .map_err(failed)?,
        Err(_) => builder,
    };
    builder.build().map_err(failed)
}

pub async fn check(
    handle: &AppHandle,
    pending: &State<'_, Pending>,
) -> Result<Option<Available>, AppError> {
    let update = updater(handle)?.check().await.map_err(failed)?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().expect("update") = update;
    Ok(available)
}

/// Windows closes the app to run the installer, so only other systems get here.
pub async fn install(handle: &AppHandle, pending: &State<'_, Pending>) -> Result<(), AppError> {
    let update = pending
        .0
        .lock()
        .expect("update")
        .clone()
        .ok_or_else(|| failed("No update to install."))?;
    let mut received = 0;
    update
        .download_and_install(
            |chunk, total| {
                received += chunk as u64;
                let _ = handle.emit_to("main", PROGRESS, Progress { received, total });
            },
            || {},
        )
        .await
        .map_err(failed)?;
    handle.restart();
}

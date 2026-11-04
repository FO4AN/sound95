//! Makes sure GStreamer can play SoundCloud's AAC HLS streams, installing the
//! distro's plug-in packages if not. Root access goes through pkexec, so the
//! user approves the install in their desktop's password prompt.

use crate::client::AppError;
use serde::Serialize;
use std::{
    path::Path,
    process::{Command, Stdio},
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Installer {
    pub name: &'static str,
    pub args: &'static [&'static str],
}

const INSTALLERS: &[Installer] = &[
    Installer {
        name: "pacman",
        args: &[
            "-S",
            "--needed",
            "--noconfirm",
            "gst-plugins-good",
            "gst-plugins-bad",
            "gst-libav",
        ],
    },
    Installer {
        name: "apt-get",
        args: &[
            "install",
            "-y",
            "gstreamer1.0-plugins-good",
            "gstreamer1.0-plugins-bad",
            "gstreamer1.0-libav",
        ],
    },
    Installer {
        name: "dnf",
        args: &[
            "install",
            "-y",
            "gstreamer1-plugins-good",
            "gstreamer1-plugins-bad-free",
            "gstreamer1-libav",
        ],
    },
    Installer {
        name: "zypper",
        args: &[
            "--non-interactive",
            "install",
            "gstreamer-plugins-good",
            "gstreamer-plugins-bad",
            "gstreamer-plugins-libav",
        ],
    },
];

#[derive(Serialize)]
pub struct AudioStatus {
    pub ready: bool,
    pub can_install: bool,
    pub command: Option<String>,
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| Path::new(&dir).join(program).is_file())
    })
}

fn has_element(element: &str) -> bool {
    Command::new("gst-inspect-1.0")
        .args(["--exists", element])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Without gst-inspect-1.0 there's no telling, and Debian keeps it out of the
/// plug-in packages. Playback gets to try rather than asking for a password on
/// every launch to install what's already there.
fn ready(can_check: bool, has: impl Fn(&str) -> bool) -> bool {
    !can_check
        || (["hlsdemux2", "hlsdemux"].iter().any(|e| has(e))
            && has("qtdemux")
            && ["avdec_aac", "fdkaacdec", "faad"].iter().any(|e| has(e)))
}

fn detect(installed: impl Fn(&str) -> bool) -> Option<Installer> {
    INSTALLERS.iter().copied().find(|i| installed(i.name))
}

pub fn status() -> AudioStatus {
    // Windows plays through WebView2, and an AppImage carries its own plug-ins.
    if cfg!(windows) || std::env::var_os("APPIMAGE").is_some() {
        return AudioStatus {
            ready: true,
            can_install: false,
            command: None,
        };
    }
    let installer = detect(on_path);
    AudioStatus {
        ready: ready(on_path("gst-inspect-1.0"), has_element),
        can_install: installer.is_some() && on_path("pkexec"),
        command: installer.map(|i| format!("sudo {} {}", i.name, i.args.join(" "))),
    }
}

pub fn install() -> Result<(), AppError> {
    let installer = detect(on_path).ok_or_else(|| {
        AppError::new(
            "audio_unsupported",
            "No supported package manager was found.",
        )
    })?;
    let result = Command::new("pkexec")
        .arg(installer.name)
        .args(installer.args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| AppError::new("audio_install", format!("Could not start pkexec: {e}")))?;
    match result.status.code() {
        Some(0) => Ok(()),
        // pkexec's own exit codes for a dismissed or refused password prompt.
        Some(126 | 127) => Err(AppError::new(
            "audio_declined",
            "The password prompt was dismissed.",
        )),
        _ => {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let detail = stderr.lines().last().unwrap_or("unknown error");
            Err(AppError::new(
                "audio_install",
                format!("{} failed: {detail}", installer.name),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_systems_package_manager() {
        assert_eq!(detect(|p| p == "pacman").unwrap().name, "pacman");
        assert_eq!(detect(|p| p == "apt-get").unwrap().name, "apt-get");
        assert!(detect(|_| false).is_none());
    }

    #[test]
    fn plug_ins_are_only_missing_when_the_checker_says_so() {
        let found = |e: &str| ["hlsdemux2", "qtdemux", "avdec_aac"].contains(&e);
        assert!(ready(true, found));
        assert!(!ready(true, |e| e != "qtdemux"));
        assert!(!ready(true, |_| false));
        // No gst-inspect-1.0 to ask.
        assert!(ready(false, |_| false));
    }

    #[test]
    fn every_installer_runs_unattended_with_three_packages() {
        for installer in INSTALLERS {
            let unattended = ["--noconfirm", "-y", "--non-interactive"];
            assert!(
                installer.args.iter().any(|a| unattended.contains(a)),
                "{}",
                installer.name
            );
            assert_eq!(
                installer.args.iter().filter(|a| a.contains("gst")).count(),
                3,
                "{}",
                installer.name
            );
        }
    }
}

//! The tray icon. Closing the window leaves Sound95 playing here, with the
//! playback controls one right click away.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, Wry,
};

const EVENT: &str = "sound95:tray";
const LONGEST_TEXT: usize = 80;

pub struct Tray {
    icon: TrayIcon,
    now: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
    next: MenuItem<Wry>,
    previous: MenuItem<Wry>,
    show: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    closes_to_tray: AtomicBool,
}

/// The menu's words, which come from the page because it knows the language.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    now: String,
    has_track: bool,
    toggle: String,
    next: String,
    previous: String,
    show: String,
    quit: String,
}

/// Menus read `&` as a shortcut marker, and track titles are full of them.
fn menu_text(text: &str) -> String {
    let short: String = text.chars().take(LONGEST_TEXT).collect();
    short.replace('&', "&&")
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn build(app: &App) -> tauri::Result<Tray> {
    let item =
        |id: &str, text: &str, enabled| MenuItem::with_id(app, id, text, enabled, None::<&str>);
    let now = item("now", "Sound95", false)?;
    let toggle = item("toggle", "Play", false)?;
    let next = item("next", "Next", false)?;
    let previous = item("previous", "Previous", false)?;
    let show_item = item("show", "Show Sound95", true)?;
    let quit = item("quit", "Quit", true)?;
    let menu = Menu::with_items(
        app,
        &[
            &now,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &next,
            &previous,
            &PredefinedMenuItem::separator(app)?,
            &show_item,
            &quit,
        ],
    )?;
    let mut icon = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Sound95")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "quit" => app.exit(0),
            action => {
                let _ = app.emit_to("main", EVENT, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(image) = app.default_window_icon() {
        icon = icon.icon(image.clone());
    }
    Ok(Tray {
        icon: icon.build(app)?,
        now,
        toggle,
        next,
        previous,
        show: show_item,
        quit,
        closes_to_tray: AtomicBool::new(true),
    })
}

impl Tray {
    pub fn closes_to_tray(&self) -> bool {
        self.closes_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_closes_to_tray(&self, closes: bool) {
        self.closes_to_tray.store(closes, Ordering::Relaxed);
    }

    pub fn update(&self, labels: &Labels) -> tauri::Result<()> {
        self.now.set_text(menu_text(&labels.now))?;
        self.toggle.set_text(&labels.toggle)?;
        self.next.set_text(&labels.next)?;
        self.previous.set_text(&labels.previous)?;
        self.show.set_text(&labels.show)?;
        self.quit.set_text(&labels.quit)?;
        for item in [&self.toggle, &self.next, &self.previous] {
            item.set_enabled(labels.has_track)?;
        }
        let tip: String = labels.now.chars().take(LONGEST_TEXT).collect();
        self.icon.set_tooltip(Some(tip))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_text_keeps_ampersands_and_stays_short() {
        assert_eq!(menu_text("Drum & Bass"), "Drum && Bass");
        assert_eq!(menu_text(&"é".repeat(200)).chars().count(), LONGEST_TEXT);
    }
}

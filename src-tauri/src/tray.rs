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

/// Whether anything will draw the icon. GNOME without the AppIndicator
/// extension builds it without complaint and never shows it, and closing to an
/// icon nobody can see would leave Sound95 playing out of reach.
#[cfg(target_os = "linux")]
pub fn host_present() -> bool {
    host::status_notifier() || host::xembed()
}

#[cfg(not(target_os = "linux"))]
pub fn host_present() -> bool {
    true
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

/// Asks the desktop directly, over the D-Bus and X11 sockets, because the tray
/// library can't say whether its icon is on screen. Each check is a couple of
/// small requests that give up quickly, and runs when the window is closed.
#[cfg(target_os = "linux")]
mod host {
    use std::{
        env,
        io::{self, Read, Write},
        os::unix::net::UnixStream,
        time::Duration,
    };

    const WAIT: Duration = Duration::from_millis(300);
    /// What the tray library looks for: KDE, the GNOME extension and most panels.
    pub(super) const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    const BUS: &str = "org.freedesktop.DBus";
    const ASK_SERIAL: u32 = 2;
    const LONGEST_MESSAGE: usize = 1 << 16;

    fn bad() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, "unexpected answer")
    }

    fn unix_socket(path: &str, abstract_name: bool) -> io::Result<UnixStream> {
        let socket = if abstract_name {
            use std::os::{linux::net::SocketAddrExt, unix::net::SocketAddr};
            UnixStream::connect_addr(&SocketAddr::from_abstract_name(path.as_bytes())?)?
        } else {
            UnixStream::connect(path)?
        };
        socket.set_read_timeout(Some(WAIT))?;
        socket.set_write_timeout(Some(WAIT))?;
        Ok(socket)
    }

    /// D-Bus addresses escape bytes as %XX.
    fn unescape(value: &str) -> String {
        let digit = |b: Option<u8>| (b? as char).to_digit(16);
        let mut out = Vec::new();
        let mut bytes = value.bytes();
        while let Some(b) = bytes.next() {
            if b != b'%' {
                out.push(b);
                continue;
            }
            match (digit(bytes.next()), digit(bytes.next())) {
                (Some(hi), Some(lo)) => out.push((hi * 16 + lo) as u8),
                _ => out.push(b),
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// The Unix sockets in a bus address, as (path, abstract).
    pub(super) fn bus_sockets(address: &str) -> Vec<(String, bool)> {
        address
            .split(';')
            .filter_map(|entry| entry.strip_prefix("unix:"))
            .filter_map(|keys| {
                keys.split(',')
                    .find_map(|pair| match pair.split_once('=')? {
                        ("path", value) => Some((unescape(value), false)),
                        ("abstract", value) => Some((unescape(value), true)),
                        _ => None,
                    })
            })
            .collect()
    }

    fn pad(buf: &mut Vec<u8>, to: usize) {
        buf.resize(buf.len().next_multiple_of(to), 0);
    }

    fn put_str(buf: &mut Vec<u8>, text: &str) {
        pad(buf, 4);
        buf.extend((text.len() as u32).to_le_bytes());
        buf.extend(text.as_bytes());
        buf.push(0);
    }

    /// A method call on the bus itself, with at most one string argument.
    fn bus_call(serial: u32, member: &str, arg: Option<&str>) -> Vec<u8> {
        let mut body = Vec::new();
        if let Some(arg) = arg {
            put_str(&mut body, arg);
        }
        // Header fields start 16 bytes in, so padding here lines up with the message.
        let mut fields = Vec::new();
        for (code, kind, value) in [
            (1, b'o', "/org/freedesktop/DBus"),
            (2, b's', BUS),
            (3, b's', member),
            (6, b's', BUS),
        ] {
            pad(&mut fields, 8);
            fields.extend([code, 1, kind, 0]);
            put_str(&mut fields, value);
        }
        if arg.is_some() {
            pad(&mut fields, 8);
            fields.extend([8, 1, b'g', 0, 1, b's', 0]);
        }
        let mut message = vec![b'l', 1, 0, 1];
        message.extend((body.len() as u32).to_le_bytes());
        message.extend(serial.to_le_bytes());
        message.extend((fields.len() as u32).to_le_bytes());
        message.extend(fields);
        pad(&mut message, 8);
        message.extend(body);
        message
    }

    /// Reads one message and returns its type, the serial it answers and its body.
    pub(super) fn read_message(socket: &mut impl Read) -> io::Result<(u8, Option<u32>, Vec<u8>)> {
        let mut head = [0; 16];
        socket.read_exact(&mut head)?;
        let little = head[0] == b'l';
        let number = |bytes: &[u8], at: usize| -> Option<u32> {
            let word: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
            Some(if little {
                u32::from_le_bytes(word)
            } else {
                u32::from_be_bytes(word)
            })
        };
        let body_len = number(&head, 4).ok_or_else(bad)? as usize;
        let fields_len = number(&head, 12).ok_or_else(bad)? as usize;
        if body_len > LONGEST_MESSAGE || fields_len > LONGEST_MESSAGE {
            return Err(bad());
        }
        let mut fields = vec![0; fields_len.next_multiple_of(8)];
        socket.read_exact(&mut fields)?;
        let mut body = vec![0; body_len];
        socket.read_exact(&mut body)?;
        fields.truncate(fields_len);
        let mut answers = None;
        let mut at = 0;
        while at < fields.len() {
            at = at.next_multiple_of(8);
            let (code, kind) = match fields.get(at..at + 4) {
                Some(&[code, 1, kind, 0]) => (code, kind),
                _ => return Err(bad()),
            };
            at += 4;
            match kind {
                b'u' => {
                    let value = number(&fields, at).ok_or_else(bad)?;
                    if code == 5 {
                        answers = Some(value);
                    }
                    at += 4;
                }
                b's' | b'o' => at += 4 + number(&fields, at).ok_or_else(bad)? as usize + 1,
                b'g' => at += 1 + *fields.get(at).ok_or_else(bad)? as usize + 1,
                _ => return Err(bad()),
            }
        }
        Ok((head[1], answers, body))
    }

    pub(super) fn has_owner(path: &str, abstract_name: bool, name: &str) -> io::Result<bool> {
        let mut socket = unix_socket(path, abstract_name)?;
        let uid = std::fs::metadata("/proc/self").map(|m| {
            use std::os::unix::fs::MetadataExt;
            m.uid()
        })?;
        let hex: String = uid
            .to_string()
            .bytes()
            .map(|b| format!("{b:02x}"))
            .collect();
        socket.write_all(format!("\0AUTH EXTERNAL {hex}\r\n").as_bytes())?;
        let mut line = Vec::new();
        let mut byte = [0];
        while !line.ends_with(b"\r\n") && line.len() < 256 {
            socket.read_exact(&mut byte)?;
            line.push(byte[0]);
        }
        if !line.starts_with(b"OK ") {
            return Err(bad());
        }
        let mut request = b"BEGIN\r\n".to_vec();
        request.extend(bus_call(1, "Hello", None));
        request.extend(bus_call(ASK_SERIAL, "NameHasOwner", Some(name)));
        socket.write_all(&request)?;
        // The answer to Hello and a signal or two can come first.
        for _ in 0..8 {
            match read_message(&mut socket)? {
                (2, Some(ASK_SERIAL), body) => {
                    return Ok(body.get(..4).is_some_and(|b| b != [0; 4]))
                }
                (3, Some(ASK_SERIAL), _) => return Err(bad()),
                _ => {}
            }
        }
        Err(bad())
    }

    /// Whether a StatusNotifierItem host is running on the session bus.
    pub fn status_notifier() -> bool {
        let address = env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_else(|_| {
            format!(
                "unix:path={}/bus",
                env::var("XDG_RUNTIME_DIR").unwrap_or_default()
            )
        });
        bus_sockets(&address)
            .iter()
            .find_map(|(path, abstract_name)| has_owner(path, *abstract_name, WATCHER).ok())
            .unwrap_or(false)
    }

    /// The display number and screen of a local X display such as ":0.0".
    pub(super) fn local_display(display: &str) -> Option<(&str, &str)> {
        let (host, rest) = display.rsplit_once(':')?;
        if !host.is_empty() && host != "unix" {
            return None;
        }
        let (number, screen) = rest.split_once('.').unwrap_or((rest, "0"));
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        (digits(number) && digits(screen)).then_some((number, screen))
    }

    /// The X authority entry for a local display, as (name, data).
    pub(super) fn x_cookie(
        file: &[u8],
        hostname: &str,
        number: &str,
    ) -> Option<(Vec<u8>, Vec<u8>)> {
        const LOCAL: u16 = 256;
        const ANY: u16 = 65535;
        let mut rest = file;
        let take = |rest: &mut &[u8]| -> Option<Vec<u8>> {
            let len = u16::from_be_bytes(rest.get(..2)?.try_into().ok()?) as usize;
            let value = rest.get(2..2 + len)?.to_vec();
            *rest = &rest[2 + len..];
            Some(value)
        };
        while rest.len() >= 2 {
            let family = u16::from_be_bytes(rest[..2].try_into().ok()?);
            rest = &rest[2..];
            let address = take(&mut rest)?;
            let display = take(&mut rest)?;
            let name = take(&mut rest)?;
            let data = take(&mut rest)?;
            let here = family == ANY || (family == LOCAL && address == hostname.as_bytes());
            if here && (display.is_empty() || display == number.as_bytes()) {
                return Some((name, data));
            }
        }
        None
    }

    fn x_request(socket: &mut UnixStream, request: &[u8]) -> io::Result<[u8; 32]> {
        socket.write_all(request)?;
        let mut reply = [0; 32];
        socket.read_exact(&mut reply)?;
        // 1 is a reply. Anything else here is an error.
        if reply[0] != 1 {
            return Err(bad());
        }
        Ok(reply)
    }

    pub(super) fn selection_owned(
        socket: &mut UnixStream,
        cookie: (Vec<u8>, Vec<u8>),
        selection: &str,
    ) -> io::Result<bool> {
        let (name, data) = cookie;
        let mut setup = vec![b'l', 0, 11, 0, 0, 0];
        setup.extend((name.len() as u16).to_le_bytes());
        setup.extend((data.len() as u16).to_le_bytes());
        setup.extend([0, 0]);
        setup.extend(&name);
        pad(&mut setup, 4);
        setup.extend(&data);
        pad(&mut setup, 4);
        socket.write_all(&setup)?;
        let mut head = [0; 8];
        socket.read_exact(&mut head)?;
        let extra = u16::from_le_bytes([head[6], head[7]]) as usize * 4;
        socket.read_exact(&mut vec![0; extra])?;
        if head[0] != 1 {
            return Err(bad());
        }
        // InternAtom, only if it exists: a tray that took the selection made it.
        let mut intern = vec![16, 1];
        intern.extend(((8 + selection.len().next_multiple_of(4)) as u16 / 4).to_le_bytes());
        intern.extend((selection.len() as u16).to_le_bytes());
        intern.extend([0, 0]);
        intern.extend(selection.as_bytes());
        pad(&mut intern, 4);
        let atom: [u8; 4] = x_request(socket, &intern)?[8..12]
            .try_into()
            .map_err(|_| bad())?;
        if atom == [0; 4] {
            return Ok(false);
        }
        // GetSelectionOwner.
        let mut owner = vec![23, 0, 2, 0];
        owner.extend(atom);
        Ok(x_request(socket, &owner)?[8..12] != [0; 4])
    }

    /// Whether an XEmbed tray such as i3bar, tint2 or stalonetray owns this
    /// screen's tray, which the tray library falls back to on X11. On Wayland
    /// nothing shows those icons.
    pub fn xembed() -> bool {
        let x11_first = env::var("GDK_BACKEND").is_ok_and(|b| b.starts_with("x11"));
        if !x11_first && env::var_os("WAYLAND_DISPLAY").is_some_and(|d| !d.is_empty()) {
            return false;
        }
        let Ok(display) = env::var("DISPLAY") else {
            return false;
        };
        let Some((number, screen)) = local_display(&display) else {
            return false;
        };
        let file = env::var_os("XAUTHORITY")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".Xauthority"))
            })
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default();
        let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default();
        // Without a cookie the server may still let this user in.
        let cookie = x_cookie(&file, hostname.trim(), number).unwrap_or_default();
        let path = format!("/tmp/.X11-unix/X{number}");
        let selection = format!("_NET_SYSTEM_TRAY_S{screen}");
        unix_socket(&path, false)
            .or_else(|_| unix_socket(&path, true))
            .and_then(|mut socket| selection_owned(&mut socket, cookie, &selection))
            .unwrap_or(false)
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

    #[cfg(target_os = "linux")]
    mod host_checks {
        use super::super::host::*;
        use std::{
            io::{Read, Write},
            os::unix::net::{UnixListener, UnixStream},
            thread,
        };

        /// What dbus-daemon sent for Hello, the NameAcquired signal and a
        /// NameHasOwner that came back true.
        const BUS_ANSWERS: &str = "6c02010109000000010000003d00000006017300040000003a312e31000000000501750001000000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000040000003a312e31006c04010109000000020000008d00000001016f00150000002f6f72672f667265656465736b746f702f4442757300000002017300140000006f72672e667265656465736b746f702e4442757300000000030173000c0000004e616d6541637175697265640000000006017300040000003a312e3100000000080167000173000007017300140000006f72672e667265656465736b746f702e4442757300000000040000003a312e31006c02010104000000030000003d00000006017300040000003a312e31000000000501750002000000080167000162000007017300140000006f72672e667265656465736b746f702e444275730000000001000000";

        fn unhex(hex: &str) -> Vec<u8> {
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect()
        }

        fn listener(name: &str) -> (UnixListener, String) {
            let path = std::env::temp_dir()
                .join(format!("sound95-tray-{name}-{}", std::process::id()))
                .to_string_lossy()
                .into_owned();
            let _ = std::fs::remove_file(&path);
            (UnixListener::bind(&path).unwrap(), path)
        }

        /// A session bus that answers the way dbus-daemon does.
        fn ask_bus(answers: Vec<u8>) -> bool {
            let (listener, path) = listener(&format!("bus-{}", answers[answers.len() - 4]));
            let bus = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut line = Vec::new();
                let mut byte = [0];
                while !line.ends_with(b"\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    line.push(byte[0]);
                }
                assert!(line.starts_with(b"\0AUTH EXTERNAL "));
                socket.write_all(b"OK 0123456789abcdef\r\n").unwrap();
                let mut begin = [0; 7];
                socket.read_exact(&mut begin).unwrap();
                assert_eq!(&begin, b"BEGIN\r\n");
                let (kind, _, _) = read_message(&mut socket).unwrap();
                assert_eq!(kind, 1);
                let (kind, _, body) = read_message(&mut socket).unwrap();
                assert_eq!(kind, 1);
                assert_eq!(&body[4..4 + WATCHER.len()], WATCHER.as_bytes());
                socket.write_all(&answers).unwrap();
            });
            let owned = has_owner(&path, false, WATCHER).unwrap();
            bus.join().unwrap();
            let _ = std::fs::remove_file(path);
            owned
        }

        #[test]
        fn finds_a_status_notifier_host_on_the_bus() {
            let mut answers = unhex(BUS_ANSWERS);
            assert!(ask_bus(answers.clone()));
            let last = answers.len() - 4;
            answers[last] = 0;
            assert!(!ask_bus(answers));
        }

        #[test]
        fn bus_addresses_are_read_as_dbus_writes_them() {
            assert_eq!(
                bus_sockets("unix:path=/run/user/1000/bus"),
                [("/run/user/1000/bus".to_string(), false)]
            );
            assert_eq!(
                bus_sockets("tcp:host=x,port=1;unix:abstract=/tmp/dbus-a%2cb,guid=7"),
                [("/tmp/dbus-a,b".to_string(), true)]
            );
            assert!(bus_sockets("").is_empty());
        }

        #[test]
        fn only_local_x_displays_are_asked() {
            assert_eq!(local_display(":0"), Some(("0", "0")));
            assert_eq!(local_display("unix:1.2"), Some(("1", "2")));
            assert_eq!(local_display("localhost:10.0"), None);
            assert_eq!(local_display(":x"), None);
        }

        #[test]
        fn x_cookies_are_matched_to_this_machine_and_display() {
            let entry = |family: u16, address: &str, number: &str, data: &[u8]| {
                let mut out = family.to_be_bytes().to_vec();
                for field in [
                    address.as_bytes(),
                    number.as_bytes(),
                    b"MIT-MAGIC-COOKIE-1",
                    data,
                ] {
                    out.extend((field.len() as u16).to_be_bytes());
                    out.extend(field);
                }
                out
            };
            let mut file = entry(256, "elsewhere", "0", b"a");
            file.extend(entry(256, "here", "1", b"b"));
            file.extend(entry(256, "here", "0", b"c"));
            let (name, data) = x_cookie(&file, "here", "0").unwrap();
            assert_eq!(
                (name.as_slice(), data.as_slice()),
                (&b"MIT-MAGIC-COOKIE-1"[..], &b"c"[..])
            );
            assert_eq!(
                x_cookie(&entry(65535, "", "", b"d"), "here", "3")
                    .unwrap()
                    .1,
                b"d"
            );
            assert!(x_cookie(&file, "here", "2").is_none());
            assert!(x_cookie(&file[..5], "here", "0").is_none());
        }

        /// An X server where `owner` holds the tray selection.
        fn ask_x(owner: u32) -> bool {
            let (listener, path) = listener(&format!("x-{owner}"));
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut setup = [0; 12];
                socket.read_exact(&mut setup).unwrap();
                assert_eq!(&setup[..4], &[b'l', 0, 11, 0]);
                let name = u16::from_le_bytes([setup[6], setup[7]]) as usize;
                let data = u16::from_le_bytes([setup[8], setup[9]]) as usize;
                let mut auth = vec![0; name.next_multiple_of(4) + data.next_multiple_of(4)];
                socket.read_exact(&mut auth).unwrap();
                assert_eq!(&auth[..18], b"MIT-MAGIC-COOKIE-1");
                socket.write_all(&[1, 0, 11, 0, 0, 0, 0, 0]).unwrap();
                let mut head = [0; 4];
                socket.read_exact(&mut head).unwrap();
                assert_eq!(head[0], 16);
                let mut rest = vec![0; u16::from_le_bytes([head[2], head[3]]) as usize * 4 - 4];
                socket.read_exact(&mut rest).unwrap();
                let atom = String::from_utf8_lossy(&rest[4..4 + rest[0] as usize]).into_owned();
                assert_eq!(atom, "_NET_SYSTEM_TRAY_S0");
                let mut reply = [0; 32];
                reply[0] = 1;
                reply[8..12].copy_from_slice(&300u32.to_le_bytes());
                socket.write_all(&reply).unwrap();
                let mut ask = [0; 8];
                socket.read_exact(&mut ask).unwrap();
                assert_eq!(ask, [23, 0, 2, 0, 44, 1, 0, 0]);
                reply[8..12].copy_from_slice(&owner.to_le_bytes());
                socket.write_all(&reply).unwrap();
            });
            let mut socket = UnixStream::connect(&path).unwrap();
            let cookie = (b"MIT-MAGIC-COOKIE-1".to_vec(), vec![7; 16]);
            let owned = selection_owned(&mut socket, cookie, "_NET_SYSTEM_TRAY_S0").unwrap();
            server.join().unwrap();
            let _ = std::fs::remove_file(path);
            owned
        }

        #[test]
        fn finds_an_xembed_tray() {
            assert!(ask_x(0x200001));
            assert!(!ask_x(0));
        }
    }
}

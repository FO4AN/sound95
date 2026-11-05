//! Shows what's playing on your Discord profile, when you've switched that on.
//! Discord runs its own local socket for this, so nothing leaves the machine
//! except through Discord itself, and it not running is perfectly normal.

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Button, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;
use std::{
    sync::{
        mpsc::{self, RecvTimeoutError, Sender},
        Mutex,
    },
    thread,
    time::Duration,
};

/// From the Discord Developer Portal. Its name there is the name people see.
const APP_ID: &str = "1566966205221441698";
const SITE: &str = "https://sound95.lol";
const SITE_LABEL: &str = "sound95.lol";
const RETRY: Duration = Duration::from_secs(15);
const SHORTEST_TEXT: usize = 2;
const LONGEST_TEXT: usize = 128;
const LONGEST_LABEL: usize = 32;
const LONGEST_IMAGE: usize = 256;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playing {
    title: String,
    artist: String,
    link: String,
    artwork: String,
    listen: String,
    started_at: i64,
    ends_at: Option<i64>,
}

/// Discord rejects a whole update over text outside these limits.
fn fit(text: &str, longest: usize) -> String {
    let mut fitted: String = text.chars().take(longest).collect();
    while fitted.chars().count() < SHORTEST_TEXT {
        fitted.push('\u{2800}');
    }
    fitted
}

fn is_https(link: &str) -> bool {
    link.starts_with("https://")
}

fn activity(playing: &Playing) -> Activity<'_> {
    let mut timestamps = Timestamps::new().start(playing.started_at);
    if let Some(ends_at) = playing.ends_at {
        timestamps = timestamps.end(ends_at);
    }
    let mut assets = Assets::new().large_text("Sound95");
    if is_https(&playing.artwork) && playing.artwork.len() <= LONGEST_IMAGE {
        assets = assets.large_image(playing.artwork.as_str());
    }
    let mut buttons = Vec::new();
    if is_https(&playing.link) {
        buttons.push(Button::new(
            fit(&playing.listen, LONGEST_LABEL),
            playing.link.as_str(),
        ));
    }
    buttons.push(Button::new(SITE_LABEL, SITE));
    Activity::new()
        .activity_type(ActivityType::Listening)
        .details(fit(&playing.title, LONGEST_TEXT))
        .state(fit(&playing.artist, LONGEST_TEXT))
        .timestamps(timestamps)
        .assets(assets)
        .buttons(buttons)
}

fn show(client: &mut DiscordIpcClient, playing: Option<&Playing>) -> bool {
    let sent = match playing {
        Some(playing) => client.set_activity(activity(playing)),
        None => client.clear_activity(),
    };
    if sent.is_err() {
        return false;
    }
    // Each update gets an answer, and unread ones would fill the socket over time.
    let Ok((_, reply)) = client.recv() else {
        return false;
    };
    if reply["evt"] == "ERROR" || cfg!(debug_assertions) {
        eprintln!("Discord: {reply}");
    }
    true
}

enum Msg {
    Show(Option<Playing>),
    Off,
}

/// What the page last asked for.
#[derive(Default)]
struct Wanted {
    on: bool,
    playing: Option<Playing>,
    stale: bool,
}

impl Wanted {
    fn take(&mut self, msg: Msg) {
        match msg {
            Msg::Show(playing) => {
                self.on = true;
                self.stale |= self.playing != playing;
                self.playing = playing;
            }
            // Stale, because an On that's read in the same batch keeps the
            // connection, and whatever it shows then has to be sent again.
            Msg::Off => {
                *self = Self {
                    stale: true,
                    ..Self::default()
                }
            }
        }
    }
}

fn run(id: &str, retry: Duration, updates: mpsc::Receiver<Msg>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut wanted = Wanted::default();
    // Whether the connection has worked, so a failure means Discord went away.
    let mut proven = false;
    let mut wait = retry;
    loop {
        match updates.recv_timeout(wait) {
            Ok(msg) => wanted.take(msg),
            // Nothing is read between updates, so resending what's showing is
            // how a restarted Discord gets noticed.
            Err(RecvTimeoutError::Timeout) => wanted.stale |= wanted.playing.is_some(),
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Updates pile up while Discord is slow to answer. Only the newest counts.
        updates.try_iter().for_each(|msg| wanted.take(msg));
        wait = retry;
        if !wanted.on {
            if let Some(mut connected) = client.take() {
                show(&mut connected, None);
                let _ = connected.close();
            }
            continue;
        }
        let Some(connected) = client.as_mut() else {
            let mut fresh = DiscordIpcClient::new(id);
            if fresh.connect().is_ok() {
                client = Some(fresh);
                proven = false;
                wanted.stale = true;
                // Connecting can take a while, so look for newer updates first.
                wait = Duration::ZERO;
            }
            continue;
        };
        if !wanted.stale {
            continue;
        }
        if show(connected, wanted.playing.as_ref()) {
            wanted.stale = false;
            proven = true;
        } else {
            // Discord quit, perhaps to restart. Try a fresh connection straight
            // away if this one used to work, and after the usual wait if not.
            client = None;
            if proven {
                wait = Duration::ZERO;
            }
        }
    }
    if let Some(mut client) = client {
        show(&mut client, None);
        let _ = client.close();
    }
}

/// One worker for the whole run, so turning presence off and on again can't
/// leave threads behind waiting on a Discord that stopped answering.
#[derive(Default)]
pub struct Discord {
    worker: Mutex<Option<Sender<Msg>>>,
}

impl Discord {
    pub fn available() -> bool {
        !APP_ID.is_empty()
    }

    pub fn update(&self, enabled: bool, playing: Option<Playing>) {
        let mut worker = self.worker.lock().expect("discord");
        let msg = if enabled && Self::available() {
            Msg::Show(playing)
        } else if worker.is_some() {
            Msg::Off
        } else {
            return;
        };
        let sender = worker.get_or_insert_with(|| {
            let (sender, updates) = mpsc::channel();
            thread::spawn(move || run(APP_ID, RETRY, updates));
            sender
        });
        let _ = sender.send(msg);
    }

    /// Clears the status and ends the worker, for when the app closes.
    pub fn shutdown(&self) {
        self.worker.lock().expect("discord").take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn playing() -> Playing {
        Playing {
            title: "HELLO".into(),
            artist: "xight".into(),
            link: "https://soundcloud.com/xight/hello".into(),
            artwork: "https://i1.sndcdn.com/artworks-1-large.jpg".into(),
            listen: "Open on SoundCloud".into(),
            started_at: 100,
            ends_at: Some(300),
        }
    }

    #[test]
    fn text_stays_within_what_discord_accepts() {
        assert_eq!(fit("A", LONGEST_TEXT).chars().count(), SHORTEST_TEXT);
        assert_eq!(fit("", LONGEST_TEXT).chars().count(), SHORTEST_TEXT);
        assert_eq!(
            fit(&"x".repeat(500), LONGEST_TEXT).chars().count(),
            LONGEST_TEXT
        );
    }

    #[test]
    fn links_that_are_not_https_are_left_out() {
        let mut odd = playing();
        odd.link = "javascript:alert(1)".into();
        odd.artwork = "file:///etc/passwd".into();
        let json = serde_json::to_value(activity(&odd)).unwrap();
        assert_eq!(json["buttons"].as_array().unwrap().len(), 1);
        assert_eq!(json["buttons"][0]["url"], SITE);
        assert!(json["assets"].get("large_image").is_none());
    }

    #[cfg(unix)]
    mod fake {
        use super::*;
        use std::{
            io::{ErrorKind, Read, Write},
            os::unix::net::{UnixListener, UnixStream},
            path::PathBuf,
            sync::MutexGuard,
            time::Instant,
        };

        /// The pipe is found through an environment variable, which every test shares.
        static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

        /// A Discord that answers the way the real one does.
        pub struct Discord {
            dir: PathBuf,
            listener: UnixListener,
            _turn: MutexGuard<'static, ()>,
        }

        impl Discord {
            pub fn start(name: &str) -> Self {
                let turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
                let dir = std::env::temp_dir()
                    .join(format!("sound95-discord-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                let listener = UnixListener::bind(dir.join("discord-ipc-0")).unwrap();
                listener.set_nonblocking(true).unwrap();
                std::env::set_var("XDG_RUNTIME_DIR", &dir);
                Self {
                    dir,
                    listener,
                    _turn: turn,
                }
            }

            /// The next connection, which must come within `within`.
            pub fn accept(&self, within: Duration) -> UnixStream {
                let deadline = Instant::now() + within;
                loop {
                    match self.listener.accept() {
                        Ok((socket, _)) => {
                            socket.set_nonblocking(false).unwrap();
                            socket
                                .set_read_timeout(Some(Duration::from_secs(5)))
                                .unwrap();
                            return socket;
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "no connection came");
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
            }

            /// Answers the handshake, as Discord does once it's ready.
            pub fn welcome(socket: &mut UnixStream) {
                assert_eq!(read_frame(socket)["client_id"], "123");
                write_frame(socket, r#"{"cmd":"DISPATCH","evt":"READY"}"#);
            }
        }

        impl Drop for Discord {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }

        pub fn read_frame(socket: &mut impl Read) -> serde_json::Value {
            let mut head = [0; 8];
            socket.read_exact(&mut head).unwrap();
            let size = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            serde_json::from_slice(&body).unwrap()
        }

        pub fn write_frame(socket: &mut impl Write, body: &str) {
            socket.write_all(&1u32.to_le_bytes()).unwrap();
            socket
                .write_all(&(body.len() as u32).to_le_bytes())
                .unwrap();
            socket.write_all(body.as_bytes()).unwrap();
        }

        /// Reads an update, answers it and returns its activity.
        pub fn shown(socket: &mut UnixStream) -> serde_json::Value {
            let update = read_frame(socket);
            assert_eq!(update["cmd"], "SET_ACTIVITY");
            write_frame(socket, "{}");
            update["args"]["activity"].clone()
        }
    }

    #[cfg(unix)]
    #[test]
    fn talks_to_discord_and_clears_up_after_itself() {
        use fake::*;
        let discord = Discord::start("talks");
        let (sender, updates) = mpsc::channel();
        let worker = thread::spawn(move || run("123", RETRY, updates));
        sender.send(Msg::Show(Some(playing()))).unwrap();

        let mut socket = discord.accept(Duration::from_secs(5));
        Discord::welcome(&mut socket);
        let status = shown(&mut socket);
        assert_eq!(status["type"], 2);
        assert_eq!(status["details"], "HELLO");
        assert_eq!(status["state"], "xight");
        assert_eq!(status["buttons"][1]["url"], SITE);

        drop(sender);
        assert!(shown(&mut socket).is_null());
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_restarted_discord_gets_the_status_back() {
        use fake::*;
        let retry = Duration::from_millis(100);
        let discord = Discord::start("restart");
        let (sender, updates) = mpsc::channel();
        let worker = thread::spawn(move || run("123", retry, updates));
        sender.send(Msg::Show(Some(playing()))).unwrap();
        let mut socket = discord.accept(Duration::from_secs(5));
        Discord::welcome(&mut socket);
        assert_eq!(shown(&mut socket)["details"], "HELLO");

        // Discord quits and comes back, and the page has nothing new to say.
        drop(socket);
        let mut socket = discord.accept(retry * 5);
        Discord::welcome(&mut socket);
        assert_eq!(shown(&mut socket)["details"], "HELLO");

        drop(sender);
        assert!(shown(&mut socket).is_null());
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_discord_only_gets_the_newest_status() {
        use fake::*;
        let discord = Discord::start("slow");
        let (sender, updates) = mpsc::channel();
        let worker = thread::spawn(move || run("123", RETRY, updates));
        sender.send(Msg::Show(Some(playing()))).unwrap();
        let mut socket = discord.accept(Duration::from_secs(5));
        // Discord takes its time to answer while the page moves on.
        let mut later = playing();
        later.title = "LATER".into();
        sender.send(Msg::Off).unwrap();
        sender.send(Msg::Show(Some(later))).unwrap();
        Discord::welcome(&mut socket);
        assert_eq!(shown(&mut socket)["details"], "LATER");

        // Off clears the status and hangs up, and on again connects anew.
        sender.send(Msg::Off).unwrap();
        assert!(shown(&mut socket).is_null());
        sender.send(Msg::Show(Some(playing()))).unwrap();
        let mut socket = discord.accept(Duration::from_secs(5));
        Discord::welcome(&mut socket);
        assert_eq!(shown(&mut socket)["details"], "HELLO");

        drop(sender);
        assert!(shown(&mut socket).is_null());
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn off_and_on_again_while_discord_is_busy_clears_the_old_track() {
        use fake::*;
        let discord = Discord::start("busy");
        let (sender, updates) = mpsc::channel();
        let worker = thread::spawn(move || run("123", RETRY, updates));
        sender.send(Msg::Show(Some(playing()))).unwrap();
        let mut socket = discord.accept(Duration::from_secs(5));
        Discord::welcome(&mut socket);
        assert_eq!(shown(&mut socket)["details"], "HELLO");

        // While Discord takes its time over an update, presence is switched off
        // and on again with nothing playing.
        let mut later = playing();
        later.title = "LATER".into();
        sender.send(Msg::Show(Some(later))).unwrap();
        assert_eq!(
            read_frame(&mut socket)["args"]["activity"]["details"],
            "LATER"
        );
        sender.send(Msg::Off).unwrap();
        sender.send(Msg::Show(None)).unwrap();
        write_frame(&mut socket, "{}");
        assert!(shown(&mut socket).is_null());

        drop(sender);
        assert!(shown(&mut socket).is_null());
        worker.join().unwrap();
    }

    #[test]
    fn nothing_starts_while_presence_is_off() {
        let discord = Discord::default();
        discord.update(false, None);
        assert!(discord.worker.lock().unwrap().is_none());
    }
}

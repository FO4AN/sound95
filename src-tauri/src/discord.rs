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

fn run(id: &str, updates: mpsc::Receiver<Option<Playing>>) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut wanted = None;
    let mut stale = false;
    loop {
        match updates.recv_timeout(RETRY) {
            Ok(playing) => {
                stale = wanted != playing;
                wanted = playing;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if client.is_none() {
            let mut fresh = DiscordIpcClient::new(id);
            if fresh.connect().is_err() {
                continue;
            }
            client = Some(fresh);
            stale = true;
        }
        if stale {
            if let Some(connected) = client.as_mut() {
                if show(connected, wanted.as_ref()) {
                    stale = false;
                } else {
                    // Discord quit. The next try reconnects and shows this again.
                    client = None;
                    stale = true;
                }
            }
        }
    }
    if let Some(mut client) = client {
        show(&mut client, None);
        let _ = client.close();
    }
}

#[derive(Default)]
pub struct Discord {
    worker: Mutex<Option<Sender<Option<Playing>>>>,
}

impl Discord {
    pub fn available() -> bool {
        !APP_ID.is_empty()
    }

    pub fn update(&self, enabled: bool, playing: Option<Playing>) {
        let mut worker = self.worker.lock().expect("discord");
        if !enabled || !Self::available() {
            // Dropping the sender ends the thread, which clears the status first.
            worker.take();
            return;
        }
        let sender = worker.get_or_insert_with(|| {
            let (sender, updates) = mpsc::channel();
            thread::spawn(move || run(APP_ID, updates));
            sender
        });
        let _ = sender.send(playing);
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
    #[test]
    fn talks_to_discord_and_clears_up_after_itself() {
        use std::{
            io::{Read, Write},
            os::unix::net::UnixListener,
        };
        fn read_frame(socket: &mut impl Read) -> serde_json::Value {
            let mut head = [0; 8];
            socket.read_exact(&mut head).unwrap();
            let size = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            serde_json::from_slice(&body).unwrap()
        }
        fn write_frame(socket: &mut impl Write, body: &str) {
            socket.write_all(&1u32.to_le_bytes()).unwrap();
            socket
                .write_all(&(body.len() as u32).to_le_bytes())
                .unwrap();
            socket.write_all(body.as_bytes()).unwrap();
        }

        let dir = std::env::temp_dir().join(format!("sound95-discord-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = UnixListener::bind(dir.join("discord-ipc-0")).unwrap();
        std::env::set_var("XDG_RUNTIME_DIR", &dir);
        let (sender, updates) = mpsc::channel();
        let worker = thread::spawn(move || run("123", updates));
        sender.send(Some(playing())).unwrap();

        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert_eq!(read_frame(&mut socket)["client_id"], "123");
        write_frame(&mut socket, r#"{"cmd":"DISPATCH","evt":"READY"}"#);
        let shown = read_frame(&mut socket);
        assert_eq!(shown["cmd"], "SET_ACTIVITY");
        assert_eq!(shown["args"]["activity"]["type"], 2);
        assert_eq!(shown["args"]["activity"]["details"], "HELLO");
        assert_eq!(shown["args"]["activity"]["state"], "xight");
        assert_eq!(shown["args"]["activity"]["buttons"][1]["url"], SITE);
        write_frame(&mut socket, "{}");

        drop(sender);
        let cleared = read_frame(&mut socket);
        assert_eq!(cleared["cmd"], "SET_ACTIVITY");
        assert!(cleared["args"]
            .get("activity")
            .is_none_or(serde_json::Value::is_null));
        write_frame(&mut socket, "{}");
        worker.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

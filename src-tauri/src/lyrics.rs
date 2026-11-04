//! Finds lyrics for a track. LRCLIB and NetEase have timed lyrics, and NetEase
//! sometimes times each word. Genius fills in the words when neither has the song.
//!
//! SoundCloud titles are messy ("Artist - Song (prod. X) [FREE]", or the same thing
//! backwards), so a title turns into a few guesses, and a result only counts if its
//! name matches one of them or its length matches the track to the second.
//!
//! Hosts are fixed here, so the page can't point this at anything else, and no
//! SoundCloud session goes near them.

use crate::client::AppError;
use reqwest::{header, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::OnceLock, time::Duration};
use url::Url;

const USER_AGENT: &str = concat!(
    "Sound95/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/FO4AN/soundscape)"
);
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY: usize = 2 * 1024 * 1024;
/// LRCLIB often answers 503 with "Retry-After: 1", then works.
const LRCLIB_TRIES: u32 = 6;
const LRCLIB_BUDGET: Duration = Duration::from_secs(12);
/// LRCLIB's answer waits for NetEase, so a slow NetEase can't hold it up for long.
const NETEASE_BUDGET: Duration = Duration::from_secs(6);
/// A host that doesn't answer at all fails this soon, not at the full timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_PAIRS: usize = 4;
const MAX_RESULTS: usize = 8;

/// Words in a bracket that say something about the upload, not the song.
const NOISE: &[&str] = &[
    "prod",
    "remix",
    "mix",
    "official",
    "video",
    "audio",
    "lyric",
    "feat",
    "ft.",
    "visuali",
    "free",
    "tiktok",
    "slowed",
    "sped",
    "speed",
    "nightcore",
    "daycore",
    "reverb",
    "tgk",
    "площадк",
    "премьера",
    "клип",
];
const NOT_THE_SONG: &[&str] = &[
    "instrumental",
    "karaoke",
    "伴奏",
    "translation",
    "перевод",
    "romanized",
    "acapella",
];
/// Tags of an upload played faster or slower, as whole words and run together.
const SPEED_CHANGED: &[&str] = &[" slowed", " sped up", " speed up", " nightcore", " daycore"];
const SPEED_CHANGED_SQUASHED: &[&str] = &["spedup", "speedup", "nightcore", "daycore"];
const CREDITS: &[&str] = &[
    "作词", "作曲", "编曲", "制作", "混音", "母带", "词:", "曲:", "词：", "曲：",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    title: String,
    artist: String,
    duration_ms: u64,
    /// The user typed these, so they're taken as they stand.
    #[serde(default)]
    exact: bool,
    /// Also fetch text-only results when timed ones exist, for the picker.
    #[serde(default)]
    everything: bool,
    /// The track's own title. A typed search often leaves out "(sped up)".
    #[serde(default)]
    speed_title: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Word {
    pub ms: u64,
    pub dur: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Line {
    pub ms: u64,
    pub dur: u64,
    pub text: String,
    pub words: Vec<Word>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub source: &'static str,
    pub title: String,
    pub artist: String,
    pub synced: bool,
    pub by_word: bool,
    /// How much longer than the track the matched recording is, in seconds.
    pub off_by: i64,
    pub speed_adjusted: bool,
    pub lines: Vec<Line>,
    #[serde(skip)]
    score: i32,
}

struct Query {
    pairs: Vec<(String, String)>,
    seconds: f64,
    speed_changed: bool,
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
            .expect("http client")
    })
}

fn base(service: &str, real: &str) -> String {
    // Lets the mock server in tools/ stand in. Compiled out of release builds.
    #[cfg(debug_assertions)]
    if let Ok(mock) = std::env::var("SOUND95_LYRICS_BASE") {
        return format!("{mock}/{service}");
    }
    let _ = service;
    real.into()
}

/* ---------- Reading a SoundCloud title ---------- */

/// SoundCloud titles love Unicode's bold and italic letters, which match nothing.
fn plain_letters(s: &str) -> String {
    s.chars()
        .map(|c| {
            let code = c as u32;
            let letter = match code {
                0x1D400..=0x1D6A3 => {
                    let n = (code - 0x1D400) % 52;
                    Some(if n < 26 {
                        b'A' + n as u8
                    } else {
                        b'a' + (n - 26) as u8
                    })
                }
                0x1D7CE..=0x1D7FF => Some(b'0' + ((code - 0x1D7CE) % 10) as u8),
                _ => None,
            };
            letter.map_or(c, char::from)
        })
        .collect()
}

fn closing(open: char) -> Option<char> {
    match open {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '【' => Some('】'),
        _ => None,
    }
}

/// Removes bracketed parts that `keep` turns down.
fn drop_brackets(s: &str, keep: impl Fn(&str) -> bool) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some((at, open)) = rest.char_indices().find(|(_, c)| closing(*c).is_some()) {
        let after = at + open.len_utf8();
        let close = closing(open).expect("is a bracket");
        let Some(end) = rest[after..].find(close) else {
            break;
        };
        // '】' takes three bytes, so step over the closing bracket by its real length.
        let stop = after + end + close.len_utf8();
        let inner = &rest[after..after + end];
        out.push_str(&rest[..at]);
        if keep(inner) {
            out.push_str(&rest[at..stop]);
        } else {
            out.push(' ');
        }
        rest = &rest[stop..];
    }
    out.push_str(rest);
    out
}

fn is_noise(inner: &str) -> bool {
    let lower = inner.to_lowercase();
    NOISE.iter().any(|n| lower.contains(n))
}

/// Where a credit starts: " prod. x", " feat y", " @handle". A mark only counts as a
/// whole word with a name after it, so "BIRDS OF A FEATHER" and "Little Feat" stay whole.
fn credit_at(lower: &str) -> Option<usize> {
    const MARKS: &[&str] = &["prod", "prodby", "produced", "feat", "featuring", "ft"];
    lower.match_indices(' ').map(|(at, _)| at).find(|&at| {
        let rest = &lower[at + 1..];
        if rest.starts_with(['@', '#']) {
            return true;
        }
        let end = rest
            .find(|c: char| !c.is_alphanumeric())
            .unwrap_or(rest.len());
        MARKS.contains(&&rest[..end]) && !rest[end..].trim_start_matches(['.', ':', ' ']).is_empty()
    })
}

/// Cuts credits and file names off the end: "song prod. x", "song.mp3", "song @handle".
fn clean(s: &str) -> String {
    let mut text = drop_brackets(s, |inner| !is_noise(inner));
    let lower = text.to_lowercase();
    if let Some(at) = credit_at(&lower) {
        // `lower` can differ in length from the original, so re-find the boundary.
        let chars = lower[..at].chars().count();
        text = text.chars().take(chars).collect();
    }
    let mut text = text.trim().to_string();
    for ending in [".mp3", ".wav", ".m4a", ".flac"] {
        if text.to_lowercase().ends_with(ending) {
            let keep = text.chars().count() - ending.len();
            text = text.chars().take(keep).collect();
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_dash(title: &str) -> Option<(&str, &str)> {
    [" - ", " – ", " — "]
        .iter()
        .find_map(|dash| title.split_once(dash))
}

/// Every reading of a title as (artist, song), best guess first.
fn guesses(title: &str, artist: &str) -> Vec<(String, String)> {
    let title = plain_letters(title);
    let artist = clean(&plain_letters(artist));
    let bare = |s: &str| clean(&drop_brackets(s, |_| false));
    let mut pairs = Vec::new();
    if let Some((left, right)) = split_dash(&title) {
        pairs.push((clean(left), clean(right)));
        pairs.push((artist.clone(), clean(right)));
        // "song - artist" turns up nearly as often.
        pairs.push((clean(right), clean(left)));
    } else if let Some((song, by)) = title.split_once(" by ") {
        pairs.push((clean(by), clean(song)));
    }
    pairs.push((artist.clone(), clean(&title)));
    pairs.push((artist, bare(&title)));
    let mut seen = Vec::new();
    pairs.retain(|(a, t)| {
        let key = format!("{}|{}", normal(a), normal(t));
        let new = !normal(t).is_empty() && !seen.contains(&key);
        seen.push(key);
        new
    });
    pairs.truncate(MAX_PAIRS);
    pairs
}

/// "(sped up)", "Sped-Up", "speedup", "slowed + reverb", "nightcore", "daycore".
fn speed_changed(title: &str) -> bool {
    let words: String = plain_letters(title)
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let words: Vec<&str> = words.split_whitespace().collect();
    let spaced = format!(" {} ", words.join(" "));
    let squashed = words.concat();
    SPEED_CHANGED.iter().any(|tag| spaced.contains(tag))
        || SPEED_CHANGED_SQUASHED
            .iter()
            .any(|tag| squashed.contains(tag))
}

fn query(req: &Request) -> Query {
    Query {
        pairs: if req.exact {
            vec![(req.artist.trim().into(), req.title.trim().into())]
        } else {
            guesses(&req.title, &req.artist)
        },
        seconds: req.duration_ms as f64 / 1000.0,
        speed_changed: speed_changed(&req.title)
            || req.speed_title.as_deref().is_some_and(speed_changed),
    }
}

/* ---------- Telling whether a result is the right song ---------- */

fn latin(c: char) -> Option<&'static str> {
    Some(match c {
        'а' => "a",
        'б' => "b",
        'в' => "v",
        'г' => "g",
        'д' => "d",
        'е' | 'ё' | 'э' | 'є' => "e",
        'ж' => "zh",
        'з' => "z",
        'и' | 'ы' | 'і' | 'ї' => "i",
        'й' => "y",
        'к' => "k",
        'л' => "l",
        'м' => "m",
        'н' => "n",
        'о' => "o",
        'п' => "p",
        'р' => "r",
        'с' => "s",
        'т' => "t",
        'у' => "u",
        'ф' => "f",
        'х' => "h",
        'ц' => "c",
        'ч' => "ch",
        'ш' => "sh",
        'щ' => "sch",
        'ъ' | 'ь' => "",
        'ю' => "yu",
        'я' => "ya",
        _ => return None,
    })
}

/// Lowercase letters and digits, with Cyrillic spelled out so that "Шарлот" meets
/// "Sharlot".
fn normal(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        match latin(c) {
            Some(spelled) => out.push_str(spelled),
            None if c.is_alphanumeric() => out.push(c),
            None => {}
        }
    }
    out
}

fn distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let cost = diagonal + usize::from(x != y);
            diagonal = row[j + 1];
            row[j + 1] = cost.min(row[j] + 1).min(row[j + 1] + 1);
        }
    }
    row[b.len()]
}

/// 2 for the same name, 1 for a close one, 0 for different.
fn similar(a: &str, b: &str) -> i32 {
    let (x, y) = (normal(a), normal(b));
    if x.is_empty() || y.is_empty() {
        return 0;
    }
    if x == y {
        return 2;
    }
    let (cx, cy): (Vec<char>, Vec<char>) = (x.chars().collect(), y.chars().collect());
    let (short, long) = (cx.len().min(cy.len()), cx.len().max(cy.len()));
    let inside = x.contains(&y) || y.contains(&x);
    let close = (long - distance(&cx, &cy)) * 5 >= long * 4;
    i32::from(close || (inside && short * 4 >= long * 3))
}

/// Each name in a credit: "A & B (Ft. C)", "A ft. B", "A X B".
fn artist_parts(s: &str) -> Vec<String> {
    // A bracket opens a feature as often as a comma does.
    let mut parts = vec![s.to_lowercase().replace(['(', ')', '[', ']'], ", ")];
    for sep in [
        ",",
        "&",
        "/",
        "、",
        "+",
        " x ",
        " feat.",
        " feat ",
        " featuring ",
        " ft.",
        " ft ",
    ] {
        parts = parts
            .iter()
            .flat_map(|part| part.split(sep))
            .map(str::to_string)
            .collect();
    }
    parts
        .iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn same_artist(a: &str, b: &str) -> i32 {
    let theirs = artist_parts(b);
    artist_parts(a)
        .iter()
        .flat_map(|x| theirs.iter().map(move |y| similar(x, y)))
        .max()
        .unwrap_or(0)
        .max(similar(a, b))
}

/// None if this isn't the song. A name match needs the artist too, unless the
/// length matches so closely that it has to be the same recording.
fn match_score(q: &Query, title: &str, artist: &str, off_by: Option<f64>) -> Option<i32> {
    let lower = title.to_lowercase();
    let same_length = off_by.is_some_and(|d| d.abs() <= 2.0);
    q.pairs
        .iter()
        .filter_map(|(a, t)| {
            // "Song (Karaoke)" isn't the song, but Drake's "Karaoke" is.
            let asked = t.to_lowercase();
            if NOT_THE_SONG
                .iter()
                .any(|word| lower.contains(word) && !asked.contains(word))
            {
                return None;
            }
            // Genius adds a translation: "ГОША И РОМА (GOSHA AND ROMA)".
            let names = similar(t, title).max(similar(t, &drop_brackets(title, |_| false)));
            let people = same_artist(a, artist);
            (names > 0 && (people > 0 || same_length)).then_some(names * 10 + people * 10)
        })
        .max()
}

fn rank(lyrics: &Lyrics, matched: i32) -> i32 {
    let kind = match (lyrics.synced, lyrics.by_word) {
        (true, true) => 300,
        (true, false) => 200,
        _ => 100,
    };
    let off = lyrics.off_by.abs();
    // Timing from a different cut drifts, so it can lose to plain text.
    let fit = match (lyrics.synced, off) {
        (false, _) => 0,
        (true, 0..=3) => 50,
        (true, 4..=8) => 20,
        (true, 9..=15) => -40,
        _ => -150,
    };
    kind + fit + matched
}

/* ---------- Lyric formats ---------- */

fn lrc_time(tag: &str) -> Option<u64> {
    let (minutes, seconds) = tag.split_once(':')?;
    let minutes: u64 = minutes.trim().parse().ok()?;
    let seconds: f64 = seconds.trim().replace(':', ".").parse().ok()?;
    Some(minutes * 60_000 + (seconds * 1000.0).round() as u64)
}

fn is_credit(text: &str) -> bool {
    CREDITS.iter().any(|c| text.contains(c))
}

fn tidy(mut lines: Vec<Line>) -> Vec<Line> {
    lines.sort_by_key(|l| l.ms);
    lines.dedup_by(|b, a| a.text.is_empty() && b.text.is_empty());
    while lines.first().is_some_and(|l| l.text.is_empty()) {
        lines.remove(0);
    }
    lines
}

/// `<mm:ss.xx>word <mm:ss.xx>word`, as some LRC files time their words.
fn enhanced_words(text: &str, end: u64) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    for piece in text.split('<').skip(1) {
        let Some((tag, word)) = piece.split_once('>') else {
            return Vec::new();
        };
        let Some(ms) = lrc_time(tag) else {
            return Vec::new();
        };
        if let Some(last) = words.last_mut() {
            last.dur = ms.saturating_sub(last.ms);
        }
        words.push(Word {
            ms,
            dur: 0,
            text: word.to_string(),
        });
    }
    if let Some(last) = words.last_mut() {
        last.dur = end.saturating_sub(last.ms);
    }
    words
}

/// Standard LRC: `[01:02.34]line`, with several stamps when a line repeats.
pub fn parse_lrc(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while let Some(body) = rest.strip_prefix('[') {
            let Some((tag, after)) = body.split_once(']') else {
                break;
            };
            match lrc_time(tag) {
                Some(ms) => stamps.push(ms),
                None => break,
            }
            rest = after;
        }
        let rest = rest.trim();
        if rest.contains('<') {
            let words = enhanced_words(rest, 0);
            if !words.is_empty() {
                let text: String = words.iter().map(|w| w.text.as_str()).collect();
                for ms in &stamps {
                    lines.push(Line {
                        ms: *ms,
                        dur: 0,
                        text: text.trim().to_string(),
                        words: words.clone(),
                    });
                }
                continue;
            }
        }
        for ms in stamps {
            if is_credit(rest) {
                continue;
            }
            lines.push(Line {
                ms,
                dur: 0,
                text: rest.to_string(),
                words: Vec::new(),
            });
        }
    }
    let lines = tidy(lines);
    let spoken = lines.iter().filter(|l| !l.text.is_empty()).count();
    let timed = lines.iter().any(|l| l.ms > 0);
    if spoken < 3 || !timed {
        return Vec::new();
    }
    lines
}

/// `(start,duration,flag)` at the head of `s`, and how long it is.
fn yrc_stamp(s: &str) -> Option<(u64, u64, usize)> {
    let end = s.strip_prefix('(')?.find(')')? + 1;
    let mut parts = s[1..end].split(',');
    let start = parts.next()?.parse().ok()?;
    let dur = parts.next()?.parse().ok()?;
    parts.next()?.parse::<u64>().ok()?;
    parts.next().is_none().then_some((start, dur, end + 1))
}

/// NetEase's word timing: `[start,dur](start,dur,0)word(start,dur,0)word`.
pub fn parse_yrc(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let Some(body) = raw.trim().strip_prefix('[') else {
            continue;
        };
        let Some((head, mut rest)) = body.split_once(']') else {
            continue;
        };
        let Some((start, dur)) = head.split_once(',') else {
            continue;
        };
        let (Ok(start), Ok(dur)) = (start.parse::<u64>(), dur.parse::<u64>()) else {
            continue;
        };
        let mut words: Vec<Word> = Vec::new();
        while let Some((ms, word_dur, used)) = yrc_stamp(rest) {
            rest = &rest[used..];
            let next = rest
                .char_indices()
                .find(|(i, c)| *c == '(' && yrc_stamp(&rest[*i..]).is_some())
                .map_or(rest.len(), |(i, _)| i);
            words.push(Word {
                ms,
                dur: word_dur,
                text: rest[..next].to_string(),
            });
            rest = &rest[next..];
        }
        let text: String = words.iter().map(|w| w.text.as_str()).collect();
        if !text.trim().is_empty() && !is_credit(&text) {
            lines.push(Line {
                ms: start,
                dur,
                text: text.trim().to_string(),
                words,
            });
        }
    }
    if lines.len() < 3 {
        return Vec::new();
    }
    tidy(lines)
}

/// Lines with no timing. A blank keeps its place as a verse break.
pub fn parse_plain(text: &str) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        // "[Chorus]" and the like aren't sung.
        if line.starts_with('[') && line.ends_with(']') {
            continue;
        }
        lines.push(Line {
            ms: 0,
            dur: 0,
            text: line.to_string(),
            words: Vec::new(),
        });
    }
    let mut lines = tidy(lines);
    while lines.last().is_some_and(|l| l.text.is_empty()) {
        lines.pop();
    }
    lines
}

fn decode_entities(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = rest
            .find(';')
            .filter(|end| *end <= 10)
            .map(|end| &rest[1..end]);
        let decoded = entity.and_then(|e| match e {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => {
                let number = e.strip_prefix('#')?;
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                    None => number.parse().ok()?,
                };
                char::from_u32(code)
            }
        });
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[entity.map_or(1, |e| e.len() + 2)..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The text of one tag-delimited lyrics block, starting just after its opening
/// tag. Genius nests a header in there, marked as not being part of the lyrics.
fn genius_block(html: &str) -> (String, usize) {
    let mut text = String::new();
    let mut at = 0;
    let mut depth = 1;
    let mut skipping_from = None;
    while let Some(open) = html[at..].find('<') {
        if skipping_from.is_none() {
            text.push_str(&decode_entities(&html[at..at + open]));
        }
        at += open;
        let Some(close) = html[at..].find('>') else {
            return (text, html.len());
        };
        let tag = &html[at + 1..at + close];
        at += close + 1;
        let name = tag.trim_start_matches('/');
        let name = name
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        if name == "div" && !tag.ends_with('/') {
            if tag.starts_with('/') {
                depth -= 1;
                if skipping_from == Some(depth) {
                    skipping_from = None;
                }
                if depth == 0 {
                    return (text, at);
                }
            } else {
                if skipping_from.is_none() && tag.contains("data-exclude-from-selection") {
                    skipping_from = Some(depth);
                }
                depth += 1;
            }
        } else if name == "br" && skipping_from.is_none() {
            text.push('\n');
        }
    }
    (text, html.len())
}

pub fn genius_lyrics(html: &str) -> String {
    const MARK: &str = "data-lyrics-container=\"true\"";
    let mut out = String::new();
    let mut at = 0;
    while let Some(found) = html[at..].find(MARK) {
        at += found;
        let Some(open_end) = html[at..].find('>') else {
            break;
        };
        at += open_end + 1;
        let (text, used) = genius_block(&html[at..]);
        at += used;
        out.push_str(&text);
        out.push('\n');
    }
    out
}

/* ---------- Sources ---------- */

async fn body(req: RequestBuilder) -> Result<(StatusCode, Option<u64>, Vec<u8>), reqwest::Error> {
    let mut resp = req.send().await?;
    let status = resp.status();
    let retry = resp
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if bytes.len() + chunk.len() > MAX_BODY {
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, retry, bytes))
}

/// None when the site didn't really answer: no reply, an error status, or a body
/// that isn't JSON, like a Cloudflare challenge page.
async fn json(req: RequestBuilder) -> Option<Value> {
    let (status, _, bytes) = body(req).await.ok()?;
    if !status.is_success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    // NetEase answers 200 with {"code": -460} or 405 when it refuses or rate-limits.
    if value["code"].as_i64().is_some_and(|code| code != 200) {
        return None;
    }
    Some(value)
}

fn finished(
    q: &Query,
    source: &'static str,
    title: &str,
    artist: &str,
    seconds: Option<f64>,
    mut lines: Vec<Line>,
    matched: i32,
) -> Option<Lyrics> {
    if !lines.iter().any(|l| !l.text.is_empty()) {
        return None;
    }
    let synced = lines.iter().any(|l| l.ms > 0);
    let by_word = lines.iter().any(|l| !l.words.is_empty());
    let mut off_by = seconds.map_or(0, |s| (s - q.seconds).round() as i64);
    let mut speed_adjusted = false;
    // A sped-up upload runs the same words faster, so the timing scales.
    if let Some(theirs) = seconds.filter(|s| synced && q.speed_changed && *s > 0.0) {
        let ratio = q.seconds / theirs;
        if (0.55..=1.6).contains(&ratio) && (ratio - 1.0).abs() > 0.01 {
            let scale = |ms: &mut u64| *ms = (*ms as f64 * ratio).round() as u64;
            for line in &mut lines {
                scale(&mut line.ms);
                scale(&mut line.dur);
                for word in &mut line.words {
                    scale(&mut word.ms);
                    scale(&mut word.dur);
                }
            }
            off_by = 0;
            speed_adjusted = true;
        }
    }
    let mut lyrics = Lyrics {
        source,
        title: title.to_string(),
        artist: artist.to_string(),
        synced,
        by_word,
        off_by,
        speed_adjusted,
        lines,
        score: 0,
    };
    lyrics.score = rank(&lyrics, matched);
    Some(lyrics)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrclibHit {
    track_name: Option<String>,
    artist_name: Option<String>,
    duration: Option<f64>,
    #[serde(default)]
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

/// None when it never gave a real answer, which says nothing about the song.
async fn lrclib_get(params: &[(&str, &str)]) -> Option<Vec<LrclibHit>> {
    let url = format!("{}/api/search", base("lrclib", "https://lrclib.net"));
    for attempt in 0..LRCLIB_TRIES {
        let (status, retry, bytes) = body(http().get(&url).query(params)).await.ok()?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).ok();
        }
        if !matches!(status.as_u16(), 429 | 502 | 503 | 504) {
            return None;
        }
        let wait = retry.unwrap_or(1).min(3) * 1000 + u64::from(attempt) * 150;
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    None
}

fn lrclib_results(q: &Query, hits: Vec<LrclibHit>, found: &mut Vec<Lyrics>) {
    for hit in hits {
        let (Some(title), Some(artist)) = (&hit.track_name, &hit.artist_name) else {
            continue;
        };
        if hit.instrumental {
            continue;
        }
        let off_by = hit.duration.map(|d| d - q.seconds);
        let Some(matched) = match_score(q, title, artist, off_by) else {
            continue;
        };
        let synced = hit
            .synced_lyrics
            .as_deref()
            .map(parse_lrc)
            .unwrap_or_default();
        let lines = if synced.is_empty() {
            hit.plain_lyrics
                .as_deref()
                .map(parse_plain)
                .unwrap_or_default()
        } else {
            synced
        };
        found.extend(finished(
            q,
            "LRCLIB",
            title,
            artist,
            hit.duration,
            lines,
            matched,
        ));
    }
}

fn good_enough(found: &[Lyrics]) -> bool {
    found.iter().any(|l| l.score >= 250)
}

async fn lrclib(q: &Query, found: &mut Vec<Lyrics>, failed: &mut bool) {
    let mut asked_loosely = false;
    for (artist, title) in &q.pairs {
        let exact = [
            ("track_name", title.as_str()),
            ("artist_name", artist.as_str()),
        ];
        match lrclib_get(&exact).await {
            Some(hits) => lrclib_results(q, hits, found),
            None => *failed = true,
        }
        if found.is_empty() && !asked_loosely {
            asked_loosely = true;
            let text = format!("{artist} {title}");
            match lrclib_get(&[("q", text.as_str())]).await {
                Some(hits) => lrclib_results(q, hits, found),
                None => *failed = true,
            }
        }
        if found.iter().any(|l| l.synced) {
            return;
        }
    }
}

fn netease_request(path: &str) -> RequestBuilder {
    let url = format!("{}{path}", base("netease", "https://music.163.com"));
    http()
        .get(url)
        .header(header::REFERER, "https://music.163.com/")
}

/// One search result's lyrics, if it's the song and has any.
async fn netease_song(q: &Query, song: Option<&Value>, failed: &mut bool) -> Option<Lyrics> {
    let song = song?;
    let id = song["id"].as_u64()?;
    let title = song["name"].as_str()?;
    let artists: Vec<&str> = song["artists"]
        .as_array()?
        .iter()
        .filter_map(|a| a["name"].as_str())
        .collect();
    let artist = artists.join(", ");
    let seconds = song["duration"].as_f64().map(|ms| ms / 1000.0);
    let matched = match_score(q, title, &artist, seconds.map(|s| s - q.seconds))?;
    let id = id.to_string();
    let req = netease_request("/api/song/lyric/v1").query(&[
        ("id", id.as_str()),
        ("lv", "1"),
        ("yv", "1"),
        ("kv", "0"),
        ("tv", "0"),
    ]);
    let Some(lyric) = json(req).await else {
        *failed = true;
        return None;
    };
    if lyric["pureMusic"].as_bool() == Some(true) || lyric["nolyric"].as_bool() == Some(true) {
        return None;
    }
    let words = parse_yrc(lyric["yrc"]["lyric"].as_str().unwrap_or(""));
    let lines = if words.is_empty() {
        parse_lrc(lyric["lrc"]["lyric"].as_str().unwrap_or(""))
    } else {
        words
    };
    finished(q, "NetEase", title, &artist, seconds, lines, matched)
}

async fn netease(q: &Query, found: &mut Vec<Lyrics>, failed: &mut bool) {
    let mut searched: Vec<String> = Vec::new();
    for (artist, title) in q.pairs.iter().take(2) {
        let text = format!("{artist} {title}");
        if searched.contains(&normal(&text)) {
            continue;
        }
        searched.push(normal(&text));
        let req = netease_request("/api/search/get").query(&[
            ("type", "1"),
            ("limit", "8"),
            ("s", text.as_str()),
        ]);
        let Some(results) = json(req).await else {
            // A site that didn't answer this won't answer the next one either.
            *failed = true;
            return;
        };
        let empty = Vec::new();
        let songs = results["result"]["songs"].as_array().unwrap_or(&empty);
        let mut picks = songs.iter().filter(|song| {
            let name = song["name"].as_str().unwrap_or("");
            let singer = song["artists"][0]["name"].as_str().unwrap_or("");
            let off_by = song["duration"].as_f64().map(|ms| ms / 1000.0 - q.seconds);
            match_score(q, name, singer, off_by).is_some()
        });
        // Each lyric is a round trip of its own, so the three go out together.
        let (a, b, c) = (picks.next(), picks.next(), picks.next());
        let (mut failed_a, mut failed_b, mut failed_c) = (false, false, false);
        let (a, b, c) = tokio::join!(
            netease_song(q, a, &mut failed_a),
            netease_song(q, b, &mut failed_b),
            netease_song(q, c, &mut failed_c),
        );
        *failed |= failed_a || failed_b || failed_c;
        found.extend([a, b, c].into_iter().flatten());
        if good_enough(found) {
            return;
        }
    }
}

/// Only follows a song link back to Genius itself.
fn genius_page_allowed(page: &str, genius: &str) -> bool {
    match (Url::parse(page), Url::parse(genius)) {
        (Ok(page), Ok(genius)) => page.origin() == genius.origin(),
        _ => false,
    }
}

async fn genius(q: &Query, found: &mut Vec<Lyrics>, failed: &mut bool) {
    let site = base("genius", "https://genius.com");
    for (artist, title) in q.pairs.iter().take(2) {
        let text = format!("{artist} {title}");
        let req = http()
            .get(format!("{site}/api/search/multi"))
            .query(&[("per_page", "5"), ("q", text.as_str())]);
        let Some(results) = json(req).await else {
            *failed = true;
            continue;
        };
        let empty = Vec::new();
        let sections = results["response"]["sections"].as_array().unwrap_or(&empty);
        let hit = sections
            .iter()
            .flat_map(|s| s["hits"].as_array().unwrap_or(&empty))
            .filter(|h| h["type"] == "song")
            .map(|h| &h["result"])
            .filter(|s| {
                s["instrumental"].as_bool() != Some(true) && s["lyrics_state"] == "complete"
            })
            .find_map(|s| {
                let name = s["title"].as_str()?;
                let who = s["artist_names"].as_str()?;
                Some((s, name, who, match_score(q, name, who, None)?))
            });
        let Some((song, name, who, matched)) = hit else {
            continue;
        };
        let Some(page) = song["url"]
            .as_str()
            .filter(|u| genius_page_allowed(u, &site))
        else {
            continue;
        };
        match body(http().get(page)).await {
            Ok((status, _, bytes)) if status.is_success() => {
                let lines = parse_plain(&genius_lyrics(&String::from_utf8_lossy(&bytes)));
                found.extend(finished(q, "Genius", name, who, None, lines, matched));
                return;
            }
            _ => *failed = true,
        }
    }
}

pub async fn search(req: Request) -> Result<Vec<Lyrics>, AppError> {
    let q = query(&req);
    if q.pairs.is_empty() {
        return Ok(Vec::new());
    }
    let (mut timed, mut word_timed) = (Vec::new(), Vec::new());
    let (mut failed_a, mut failed_b, mut failed_c) = (false, false, false);
    tokio::join!(
        async {
            let search = lrclib(&q, &mut timed, &mut failed_a);
            if tokio::time::timeout(LRCLIB_BUDGET, search).await.is_err() {
                failed_a = true;
            }
        },
        async {
            let search = netease(&q, &mut word_timed, &mut failed_b);
            if tokio::time::timeout(NETEASE_BUDGET, search).await.is_err() {
                failed_b = true;
            }
        },
    );
    let mut found = timed;
    found.append(&mut word_timed);
    if req.everything || !good_enough(&found) {
        genius(&q, &mut found, &mut failed_c).await;
    }
    // Nothing found while a site was down isn't the same as no lyrics existing.
    if found.is_empty() && (failed_a || failed_b || failed_c) {
        return Err(AppError::new(
            "network",
            "A lyrics site did not answer. Try again in a moment.",
        ));
    }
    found.sort_by_key(|l| -l.score);
    // The same words often come back several times from one source.
    let mut seen: Vec<(&'static str, String, bool)> = Vec::new();
    found.retain(|l| {
        let key = (l.source, normal(&l.title), l.synced);
        let new = !seen.contains(&key);
        seen.push(key);
        new
    });
    found.truncate(MAX_RESULTS);
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(a: &str, t: &str) -> (String, String) {
        (a.to_string(), t.to_string())
    }

    fn q(pairs: Vec<(String, String)>, seconds: f64) -> Query {
        Query {
            pairs,
            seconds,
            speed_changed: false,
        }
    }

    #[test]
    fn reads_messy_titles() {
        assert_eq!(
            guesses(
                "Chief Keef - I Don't Like (feat. Lil Reese)",
                "Interscope Records"
            )[0],
            pair("Chief Keef", "I Don't Like")
        );
        assert_eq!(
            guesses("type london [prod. UCV]", "ONDA ANDAR")[0],
            pair("ONDA ANDAR", "type london")
        );
        assert_eq!(
            guesses("sleep mode by onda andar [remixed by svzqe]", "svzqe")[0],
            pair("onda andar", "sleep mode")
        );
        assert_eq!(
            guesses("колумбийский.mp3", "Hariki")[0],
            pair("Hariki", "колумбийский")
        );
        assert_eq!(
            guesses("Ливаю (p. k3nnie) prod.x", "n01r")[1],
            pair("n01r", "Ливаю")
        );
        assert_eq!(
            guesses("𝘵𝘦𝘮𝘱𝘰𝘳𝘦𝘹", "𝘯𝘶𝘮𝘣𝘦𝘳𝘴")[0],
            pair("numbers", "temporex")
        );
        // Backwards titles are tried both ways round.
        assert!(guesses("sarah - alex g", "x").contains(&pair("alex g", "sarah")));
        // A bracket that belongs to the name stays in one guess and goes in another.
        let pairs = guesses("I KNOW(время 5 утра)", "widee");
        assert!(pairs.contains(&pair("widee", "I KNOW(время 5 утра)")));
        assert!(pairs.contains(&pair("widee", "I KNOW")));
    }

    #[test]
    fn full_width_brackets_do_not_panic() {
        assert!(guesses("【MV】Song Name", "Artist").contains(&pair("Artist", "Song Name")));
        assert_eq!(
            guesses("Artist - Song【Free DL】", "x")[0],
            pair("Artist", "Song")
        );
        let query = q(vec![pair("Artist", "Song")], 100.0);
        assert!(match_score(&query, "Song【Live】", "Artist", None).is_some());
    }

    #[test]
    fn matches_names_across_alphabets() {
        assert_eq!(similar("Шарлот", "Sharlot"), 2);
        assert_eq!(similar("ПОШЛАЯ МОЛЛИ", "Пошлая Молли"), 2);
        assert!(similar("Poshlaya Molli", "Poshlaya Molly") > 0);
        // A short name inside a longer one is a different song.
        assert_eq!(similar("me", "me 2"), 0);
        assert_eq!(similar("me", "Time"), 0);
        assert_eq!(same_artist("King Von", "King Von, Lil Durk"), 2);
    }

    #[test]
    fn features_are_split_off_artists() {
        assert_eq!(
            same_artist("Kendrick Lamar", "Kendrick Lamar (Ft. Drake)"),
            2
        );
        assert_eq!(same_artist("Chief Keef", "Chief Keef ft. Lil Reese"), 2);
        assert_eq!(same_artist("Chief Keef", "Chief Keef Feat. Lil Reese"), 2);
        assert_eq!(same_artist("Chief Keef", "Chief Keef X Lil Reese"), 2);
        assert_eq!(
            same_artist("Lil Pump", "Kanye West & Lil Pump (Ft. Adele Givens)"),
            2
        );
        assert!(same_artist("Lil Nas X", "Lil Nas X (Ft. Billy Ray Cyrus)") > 0);
        assert_eq!(same_artist("Simon & Garfunkel", "Simon & Garfunkel"), 2);
        assert_eq!(same_artist("Drake", "Future"), 0);
        assert_eq!(
            same_artist("Interscope Records", "Travis Scott (Ft. Drake)"),
            0
        );
    }

    #[test]
    fn credits_are_cut_only_as_whole_words() {
        assert_eq!(clean("The Prodigy"), "The Prodigy");
        assert_eq!(clean("Little Feat"), "Little Feat");
        assert_eq!(clean("My Feature"), "My Feature");
        assert_eq!(clean("Song Product"), "Song Product");
        for credited in [
            "Song prod. x",
            "Song prod by x",
            "Song produced by x",
            "Song featuring Y",
            "Song feat.y",
            "Song ft. y",
            "Song ft y",
            "Song prodby x",
            "Song @handle",
        ] {
            assert_eq!(clean(credited), "Song", "{credited}");
        }
        let pairs = guesses("BIRDS OF A FEATHER", "Billie Eilish");
        assert_eq!(pairs[0], pair("Billie Eilish", "BIRDS OF A FEATHER"));
        let query = q(pairs, 210.0);
        assert!(match_score(&query, "BIRDS OF A FEATHER", "Billie Eilish", Some(0.0)).is_some());
    }

    #[test]
    fn wrong_songs_are_turned_down() {
        let query = q(vec![pair("lungskull", "me")], 86.0);
        assert!(match_score(&query, "me", "lungskull", Some(0.0)).is_some());
        assert!(match_score(&query, "me", "someone else", Some(40.0)).is_none());
        // A same-named song by someone else passes only at the exact length.
        assert!(match_score(&query, "me", "someone else", Some(1.0)).is_some());
        assert!(match_score(&query, "me 2", "lungskull", Some(-10.0)).is_none());
        // Genius puts a translation after the name.
        let translated = q(vec![pair("3g0th2002", "ГОША И РОМА")], 162.0);
        assert!(match_score(
            &translated,
            "ГОША И РОМА (GOSHA AND ROMA)",
            "3g0th2002",
            None
        )
        .is_some());
        // A song named for one of those words is still the song.
        let karaoke = q(vec![pair("Drake", "Karaoke")], 228.0);
        assert!(match_score(&karaoke, "Karaoke", "Drake", Some(0.0)).is_some());
        let acapella = q(vec![pair("Kelis", "Acapella")], 200.0);
        assert!(match_score(&acapella, "Acapella", "Kelis", None).is_some());
        let hotline = q(vec![pair("Drake", "Hotline Bling")], 267.0);
        assert!(match_score(
            &hotline,
            "Hotline Bling (Karaoke Version)",
            "Drake",
            Some(0.0)
        )
        .is_none());
        let instrumental = q(vec![pair("alex g", "sarah")], 145.0);
        assert!(match_score(
            &instrumental,
            "sarah (Instrumental Version)",
            "alex g",
            None
        )
        .is_none());
    }

    #[test]
    fn exact_timing_beats_a_different_cut() {
        let lines = parse_lrc("[00:01.00]a\n[00:02.00]b\n[00:03.00]c");
        let query = q(vec![pair("a", "b")], 100.0);
        let right = finished(&query, "x", "b", "a", Some(100.0), lines.clone(), 40).unwrap();
        let wrong = finished(&query, "x", "b", "a", Some(190.0), lines, 40).unwrap();
        let plain = finished(&query, "x", "b", "a", None, parse_plain("a\nb"), 40).unwrap();
        assert!(right.score > plain.score);
        assert!(plain.score > wrong.score);
    }

    #[test]
    fn sped_up_uploads_scale_their_timing() {
        let lines = parse_lrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
        let mut query = q(vec![pair("a", "b")], 80.0);
        query.speed_changed = true;
        let result = finished(&query, "x", "b", "a", Some(100.0), lines, 40).unwrap();
        assert!(result.speed_adjusted);
        assert_eq!(result.off_by, 0);
        assert_eq!(result.lines[1].ms, 16_000);
    }

    #[test]
    fn spots_speed_tags_however_they_are_spelled() {
        for title in [
            "Song (sped up)",
            "Song (sped-up)",
            "Song (Speed-Up)",
            "Song (speedup)",
            "song speedup",
            "Song (daycore)",
            "Song [Slowed + Reverb]",
            "Song - nightcore",
        ] {
            assert!(speed_changed(title), "{title}");
        }
        for title in ["Speedometer", "Song (Live)", "Slow Dancing"] {
            assert!(!speed_changed(title), "{title}");
        }
        assert_eq!(
            guesses("Artist - Song (daycore)", "x")[0],
            pair("Artist", "Song")
        );
        // A typed search keeps the scaling the track's own title asks for.
        let typed = Request {
            title: "Song".into(),
            artist: "Artist".into(),
            duration_ms: 144_000,
            exact: true,
            everything: true,
            speed_title: Some("Artist - Song (sped up)".into()),
        };
        assert!(query(&typed).speed_changed);
    }

    #[test]
    fn parses_lrc() {
        let text =
            "[ar:Someone]\n[00:01.50]one\n[00:03.00][00:09.00]two\n[00:05.00]\n[00:07.25]three";
        let lines = parse_lrc(text);
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0].ms, 1500);
        assert_eq!(lines[1].text, "two");
        assert_eq!(lines[2].text, "");
        assert_eq!(lines[4].ms, 9000);
        // Credits aren't sung, and a list with no timing isn't timed.
        assert_eq!(
            parse_lrc("[00:00.00]作词 : x\n[00:01.00]a\n[00:02.00]b\n[00:03.00]c").len(),
            3
        );
        assert!(parse_lrc("[00:00.00]a\n[00:00.00]b\n[00:00.00]c").is_empty());
    }

    #[test]
    fn parses_enhanced_lrc() {
        let lines = parse_lrc("[00:01.00]<00:01.00>one <00:02.00>two\n[00:03.00]b\n[00:04.00]c");
        assert_eq!(lines[0].text, "one two");
        assert_eq!(lines[0].words[0].dur, 1000);
        assert_eq!(lines[0].words[1].ms, 2000);
    }

    #[test]
    fn parses_word_timing() {
        let text = "{\"t\":0,\"c\":[{\"tx\":\"credits\"}]}\n\
            [1000,900](1000,300,0)one (1300,600,0)(two)\n\
            [2000,500](2000,500,0)three\n[3000,500](3000,500,0)four";
        let lines = parse_yrc(text);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "one (two)");
        assert_eq!(lines[0].words.len(), 2);
        assert_eq!(lines[0].words[1].ms, 1300);
        assert_eq!(lines[0].words[1].text, "(two)");
    }

    #[test]
    fn parses_plain_text() {
        let lines = parse_plain("[Chorus]\nfirst\n\n\nsecond\n[Verse 1]\n");
        let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(text, ["first", "", "second"]);
    }

    #[test]
    fn reads_genius_pages() {
        let html = r#"<html><div data-lyrics-container="true" class="a"><div data-exclude-from-selection="true"><div>12 Contributors</div><button>Share</button></div>[Verse]<br/>It&#x27;s <a href="/x"><span>the first</span></a> line<br>second &amp; last</div>
            <div class="ad">advert</div><div data-lyrics-container="true">third</div></html>"#;
        let lines = parse_plain(&genius_lyrics(html));
        let text: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(text, ["It's the first line", "second & last", "third"]);
    }

    type Reply = (&'static str, u16, &'static str, u64);

    /// Answers each request with the first reply whose path prefix matches, after
    /// that reply's delay in ms, and points the lyrics hosts at it.
    fn serve(replies: Vec<Reply>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let replies = std::sync::Arc::new(replies);
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let replies = replies.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    let (status, text, delay) = replies
                        .iter()
                        .find(|(prefix, ..)| path.starts_with(prefix))
                        .map_or((404, "", 0), |(_, status, text, delay)| {
                            (*status, *text, *delay)
                        });
                    std::thread::sleep(Duration::from_millis(delay));
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                        text.len()
                    );
                    let _ = stream.write_all(reply.as_bytes());
                });
            }
        });
        std::env::set_var("SOUND95_LYRICS_BASE", base);
    }

    /// The mock hosts are one setting for the whole process.
    static MOCK_HOSTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn plain_request() -> Request {
        Request {
            title: "Artist - Song".into(),
            artist: "x".into(),
            duration_ms: 200_000,
            exact: false,
            everything: false,
            speed_title: None,
        }
    }

    // The mock hosts only stand in for the real ones in debug builds.
    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn netease_lyrics_are_fetched_together() {
        let _hosts = MOCK_HOSTS.lock().await;
        let song = r#"{"id":1,"name":"Song","duration":200000,"artists":[{"name":"Artist"}]}"#;
        let songs: &'static str = Box::leak(
            format!(r#"{{"code":200,"result":{{"songs":[{song},{song},{song}]}}}}"#)
                .into_boxed_str(),
        );
        serve(vec![
            ("/lrclib/", 200, "[]", 0),
            ("/netease/api/search", 200, songs, 0),
            (
                "/netease/api/song",
                200,
                r#"{"code":200,"lrc":{"lyric":"[00:01.00]a\n[00:02.00]b\n[00:03.00]c"}}"#,
                500,
            ),
            ("/genius/", 200, r#"{"response":{"sections":[]}}"#, 0),
        ]);
        let started = std::time::Instant::now();
        let found = search(plain_request()).await.expect("found");
        // One after another, the three lyrics would take 1.5 s.
        assert!(started.elapsed() < Duration::from_millis(1200));
        assert_eq!(found[0].source, "NetEase");
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn refusals_are_not_taken_for_no_lyrics() {
        let _hosts = MOCK_HOSTS.lock().await;
        serve(vec![
            ("/lrclib/", 200, "[]", 0),
            ("/netease/", 200, r#"{"code":-460,"message":"Cheating"}"#, 0),
            ("/genius/", 403, "<html>Just a moment...</html>", 0),
        ]);
        let refused = search(plain_request()).await;
        assert_eq!(refused.err().map(|e| e.code), Some("network"));
        serve(vec![
            ("/lrclib/", 200, "[]", 0),
            ("/netease/", 503, "<html>Service Unavailable</html>", 0),
            ("/genius/", 200, r#"{"response":{"sections":[]}}"#, 0),
        ]);
        assert!(search(plain_request()).await.is_err());
        // Every site answering with nothing is a real "no lyrics".
        serve(vec![
            ("/lrclib/", 200, "[]", 0),
            ("/netease/", 200, r#"{"result":{"songs":[]},"code":200}"#, 0),
            ("/genius/", 200, r#"{"response":{"sections":[]}}"#, 0),
        ]);
        assert!(search(plain_request())
            .await
            .is_ok_and(|found| found.is_empty()));
    }

    #[test]
    fn genius_links_stay_on_genius() {
        let site = "https://genius.com";
        assert!(genius_page_allowed("https://genius.com/a-b-lyrics", site));
        assert!(!genius_page_allowed("http://genius.com/a", site));
        assert!(!genius_page_allowed(
            "https://genius.com.evil.example/a",
            site
        ));
        assert!(!genius_page_allowed("file:///etc/passwd", site));
    }
}

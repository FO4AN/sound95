//! Live audio for the visualizer. Sound plays inside SoundCloud's cross-origin
//! Widget, where the page can't read it, so this taps the app's own output streams
//! through PipeWire and turns them into frequency bands.
//!
//! Only streams from this process tree are tapped, and pw-record is told not to
//! fall back when one goes away, so it stops instead of opening the microphone.

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    f32::consts::PI,
    fs,
    io::Read,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const BANDS: usize = 32;
const WAVE: usize = 96;
const FFT: usize = 2048;
const RATE: f32 = 44_100.0;
const LOW_HZ: f32 = 50.0;
const HIGH_HZ: f32 = 16_000.0;
const FRAME: Duration = Duration::from_millis(33);
/// Each new track opens a new stream, so the list has to be kept fresh.
const SCAN: Duration = Duration::from_millis(1000);
const MAX_TAPS: usize = 4;
/// Quieter than this is treated as nothing playing.
const SILENCE: f32 = 1e-6;
/// How far below the recent peak still shows, in dB.
const RANGE: f32 = 54.0;
/// The peak falls this much per frame, which works out to 3 dB a second.
const PEAK_FALL: f32 = 0.1;
/// Music is quieter the higher it goes, so highs get lifted to fill the display.
const TILT_PER_OCTAVE: f32 = 3.0;
const EVENT: &str = "sound95:visual";
const GRAPH_RATE: f64 = 48_000.0;
const GRAPH_QUANTUM: f64 = 1024.0;
const MAX_OUTPUT_MS: f64 = 1000.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    /// False when no stream could be tapped, so the numbers mean nothing.
    live: bool,
    bands: Vec<u8>,
    wave: Vec<i8>,
    level: u8,
    /// How long sound takes to reach your ears after it leaves the app.
    output_ms: u32,
}

/// In-place radix-2 FFT. Both slices must be the same power-of-two length.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * PI / len as f32;
        let half = len / 2;
        for start in (0..n).step_by(len) {
            for k in 0..half {
                let (sin, cos) = (angle * k as f32).sin_cos();
                let (a, b) = (start + k, start + k + half);
                let tr = re[b] * cos - im[b] * sin;
                let ti = re[b] * sin + im[b] * cos;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

struct Analyser {
    hann: Vec<f32>,
    edges: Vec<usize>,
    tilt: Vec<f32>,
    peak: f32,
}

impl Analyser {
    fn new() -> Self {
        let hann = (0..FFT)
            .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (FFT - 1) as f32).cos())
            .collect();
        let ratio = HIGH_HZ / LOW_HZ;
        let hz = |band: usize| LOW_HZ * ratio.powf(band as f32 / BANDS as f32);
        let bin = |f: f32| ((f * FFT as f32 / RATE) as usize).clamp(1, FFT / 2 - 1);
        Self {
            hann,
            edges: (0..=BANDS).map(|b| bin(hz(b))).collect(),
            tilt: (0..BANDS)
                .map(|b| TILT_PER_OCTAVE * (hz(b) / 1000.0).log2())
                .collect(),
            peak: -60.0,
        }
    }

    fn frame(&mut self, samples: &[f32]) -> (Vec<u8>, Vec<i8>, u8) {
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
        if samples.len() < FFT || rms < SILENCE {
            return (vec![0; BANDS], vec![0; WAVE], 0);
        }
        let recent = &samples[samples.len() - FFT..];
        let mut re: Vec<f32> = recent.iter().zip(&self.hann).map(|(s, w)| s * w).collect();
        let mut im = vec![0.0; FFT];
        fft(&mut re, &mut im);

        let mut db = [0.0f32; BANDS];
        for (band, value) in db.iter_mut().enumerate() {
            let (from, to) = (
                self.edges[band],
                self.edges[band + 1].max(self.edges[band] + 1),
            );
            let power = (from..to)
                .map(|i| re[i] * re[i] + im[i] * im[i])
                .fold(0.0, f32::max);
            let magnitude = power.sqrt() * 4.0 / FFT as f32;
            *value = 20.0 * magnitude.max(1e-9).log10() + self.tilt[band];
        }
        let loudest = db.iter().copied().fold(f32::MIN, f32::max);
        self.peak = loudest.max(self.peak - PEAK_FALL);
        let floor = self.peak - RANGE;
        let bands = db
            .iter()
            .map(|d| (((d - floor) / RANGE).clamp(0.0, 1.0) * 255.0) as u8)
            .collect();

        let window = &recent[FFT - 1024..];
        let top = window.iter().fold(SILENCE, |m, s| m.max(s.abs()));
        let wave = (0..WAVE)
            .map(|i| (window[i * window.len() / WAVE] / top * 127.0) as i8)
            .collect();
        let level =
            (((20.0 * rms.log10() - self.peak + RANGE) / RANGE).clamp(0.0, 1.0) * 255.0) as u8;
        (bands, wave, level)
    }
}

fn parent_of(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The process name can hold spaces and brackets, so read after its last ')'.
    let fields = stat.rsplit_once(')')?.1;
    fields.split_whitespace().nth(1)?.parse().ok()
}

/// WebKit's audio runs in a child process, so a stream of ours has us above it.
fn is_ours(pid: u32) -> bool {
    let me = std::process::id();
    let mut at = pid;
    for _ in 0..4 {
        if at == me {
            return true;
        }
        match parent_of(at) {
            Some(parent) if parent > 1 => at = parent,
            _ => return false,
        }
    }
    false
}

fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

struct Stream {
    serial: u64,
    node: u64,
}

/// The running playback streams in a `pw-dump` listing.
fn our_streams(dump: &Value, ours: impl Fn(u32) -> bool) -> Vec<Stream> {
    let Some(objects) = dump.as_array() else {
        return Vec::new();
    };
    objects
        .iter()
        .filter_map(|object| {
            let info = object.get("info")?;
            let props = info.get("props")?;
            if props.get("media.class")?.as_str()? != "Stream/Output/Audio"
                || info.get("state")?.as_str()? != "running"
            {
                return None;
            }
            let pid = number(props.get("application.process.id")?)? as u32;
            ours(pid).then_some(Stream {
                serial: number(props.get("object.serial")?)?,
                node: object.get("id")?.as_u64()?,
            })
        })
        .collect()
}

/// PipeWire gives a device's delay as a fixed time plus some samples and buffers.
fn latency_ms(latency: &Value) -> f64 {
    let field = |name: &str| latency[name].as_f64().unwrap_or(0.0);
    field("maxNs") / 1e6
        + field("maxRate") * 1000.0 / GRAPH_RATE
        + field("maxQuantum") * GRAPH_QUANTUM * 1000.0 / GRAPH_RATE
}

/// The delay of the device these streams play on. Bluetooth is the big one, at
/// around 300 ms, and nothing in the audio itself shows it.
fn output_delay_ms(dump: &Value, streams: &[Stream]) -> u32 {
    let Some(objects) = dump.as_array() else {
        return 0;
    };
    let infos = |kind: &'static str| {
        objects
            .iter()
            .filter(move |o| o["type"] == kind)
            .map(|o| &o["info"])
    };
    let is_ours = |id: &Value| {
        id.as_u64()
            .is_some_and(|n| streams.iter().any(|s| s.node == n))
    };
    let devices: Vec<&Value> = infos("PipeWire:Interface:Link")
        .filter(|link| is_ours(&link["output-node-id"]))
        .map(|link| &link["input-node-id"])
        .collect();
    let delay = infos("PipeWire:Interface:Port")
        .filter(|port| port["direction"] == "input" && devices.contains(&&port["props"]["node.id"]))
        .flat_map(|port| port["params"]["Latency"].as_array().into_iter().flatten())
        .filter(|latency| latency["direction"] == "Input")
        .map(latency_ms)
        .fold(0.0, f64::max);
    delay.min(MAX_OUTPUT_MS) as u32
}

/// Streams to tap, and the delay of the device they play on.
fn scan() -> Option<(Vec<u64>, u32)> {
    let output = Command::new("pw-dump")
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let dump = serde_json::from_slice(&output.stdout).ok()?;
    let streams = our_streams(&dump, is_ours);
    let delay = output_delay_ms(&dump, &streams);
    Some((streams.iter().map(|s| s.serial).collect(), delay))
}

struct Tap {
    serial: u64,
    child: Child,
    ring: Arc<Mutex<VecDeque<f32>>>,
}

impl Drop for Tap {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tap(serial: u64) -> Option<Tap> {
    let mut child = Command::new("pw-record")
        .arg("--target")
        .arg(serial.to_string())
        .args(["--format", "f32", "--rate", "44100", "--channels", "1"])
        .args(["--latency", "20ms", "--raw"])
        .arg("-P")
        .arg("{ node.dont-fallback=true node.dont-reconnect=true node.dont-move=true node.name=sound95-visualizer media.name=Visualizer }")
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let ring = Arc::new(Mutex::new(VecDeque::with_capacity(FFT)));
    let writer = ring.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut filled = 0;
        while let Ok(read) = stdout.read(&mut buffer[filled..]) {
            if read == 0 {
                return;
            }
            filled += read;
            let whole = filled - filled % 4;
            let mut samples = writer.lock().expect("ring");
            for chunk in buffer[..whole].as_chunks::<4>().0 {
                if samples.len() == FFT {
                    samples.pop_front();
                }
                samples.push_back(f32::from_le_bytes(*chunk));
            }
            drop(samples);
            buffer.copy_within(whole..filled, 0);
            filled -= whole;
        }
    });
    Some(Tap {
        serial,
        child,
        ring,
    })
}

fn run(app: AppHandle, stop: Arc<AtomicBool>) {
    let targets = Arc::new(Mutex::new((Vec::new(), 0)));
    let (scan_stop, scan_targets) = (stop.clone(), targets.clone());
    // pw-dump takes long enough to drop a frame, so it runs apart from the drawing.
    thread::spawn(move || {
        while !scan_stop.load(Ordering::Relaxed) {
            if let Some(found) = scan() {
                *scan_targets.lock().expect("targets") = found;
            }
            thread::sleep(SCAN);
        }
    });

    let mut taps: Vec<Tap> = Vec::new();
    let mut analyser = Analyser::new();
    while !stop.load(Ordering::Relaxed) {
        let (wanted, output_ms) = targets.lock().expect("targets").clone();
        taps.retain_mut(|t| wanted.contains(&t.serial) && matches!(t.child.try_wait(), Ok(None)));
        for serial in wanted {
            if taps.len() < MAX_TAPS && !taps.iter().any(|t| t.serial == serial) {
                taps.extend(tap(serial));
            }
        }
        // WebKit keeps silent streams open beside the real one.
        let loudest = taps
            .iter()
            .map(|t| {
                t.ring
                    .lock()
                    .expect("ring")
                    .iter()
                    .copied()
                    .collect::<Vec<f32>>()
            })
            .max_by(|a, b| {
                let energy = |s: &[f32]| s.iter().map(|x| x * x).sum::<f32>();
                energy(a).total_cmp(&energy(b))
            })
            .unwrap_or_default();
        let (bands, wave, level) = analyser.frame(&loudest);
        let frame = Frame {
            live: !taps.is_empty(),
            bands,
            wave,
            level,
            output_ms,
        };
        if app.emit_to("main", EVENT, frame).is_err() {
            break;
        }
        thread::sleep(FRAME);
    }
}

#[derive(Default)]
pub struct Visual {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

impl Visual {
    /// False when this system can't tap audio, so the page has to make do.
    pub fn start(&self, app: AppHandle) -> bool {
        let mut running = self.running.lock().expect("visual");
        if running.is_some() {
            return true;
        }
        let available = |tool: &str| {
            Command::new(tool)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        if !available("pw-record") || !available("pw-dump") {
            return false;
        }
        let stop = Arc::new(AtomicBool::new(false));
        *running = Some(stop.clone());
        thread::spawn(move || run(app, stop));
        true
    }

    pub fn stop(&self) {
        if let Some(stop) = self.running.lock().expect("visual").take() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tone(hz: f32, amplitude: f32) -> Vec<f32> {
        (0..FFT)
            .map(|i| amplitude * (2.0 * PI * hz * i as f32 / RATE).sin())
            .collect()
    }

    fn band_of(hz: f32) -> usize {
        let ratio = HIGH_HZ / LOW_HZ;
        ((hz / LOW_HZ).ln() / ratio.ln() * BANDS as f32) as usize
    }

    #[test]
    fn a_tone_lights_its_own_band() {
        for hz in [120.0, 1000.0, 8000.0] {
            let (bands, _, _) = Analyser::new().frame(&tone(hz, 0.5));
            let top = (0..BANDS).max_by_key(|&b| bands[b]).unwrap();
            assert!(
                // FFT bins are wider than bands at the low end.
                top.abs_diff(band_of(hz)) <= 2,
                "{hz} Hz showed in band {top}"
            );
        }
    }

    #[test]
    fn volume_does_not_change_the_picture() {
        let (loud, _, _) = Analyser::new().frame(&tone(1000.0, 0.5));
        let (quiet, _, _) = Analyser::new().frame(&tone(1000.0, 0.005));
        assert_eq!(loud.iter().max(), quiet.iter().max());
    }

    #[test]
    fn silence_shows_nothing() {
        let (bands, wave, level) = Analyser::new().frame(&vec![0.0; FFT]);
        assert!(bands.iter().all(|b| *b == 0));
        assert!(wave.iter().all(|w| *w == 0));
        assert_eq!(level, 0);
        // Nor does a capture that has only just started.
        assert_eq!(Analyser::new().frame(&[0.1; 10]).0, vec![0; BANDS]);
    }

    #[test]
    fn only_our_running_streams_are_tapped() {
        let stream = |id: u64, pid: u64, class: &str, state: &str| {
            json!({ "id": id, "info": { "state": state, "props": {
                "media.class": class, "object.serial": id + 100, "application.process.id": pid,
            } } })
        };
        let dump = json!([
            stream(1, 10, "Stream/Output/Audio", "running"),
            stream(2, 20, "Stream/Output/Audio", "running"), // another app
            stream(3, 10, "Stream/Output/Audio", "idle"),
            stream(4, 10, "Stream/Input/Audio", "running"), // a recorder
            stream(5, 10, "Audio/Source", "running"),       // a microphone
            { "info": { "props": {} } },
            { "type": "PipeWire:Interface:Link" },
        ]);
        let found = our_streams(&dump, |pid| pid == 10);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].serial, found[0].node), (101, 1));
    }

    #[test]
    fn output_delay_comes_from_the_device_we_play_on() {
        let link = |from: u64, to: u64| json!({ "type": "PipeWire:Interface:Link", "info": { "output-node-id": from, "input-node-id": to } });
        let port = |node: u64, direction: &str, latency: Value| {
            json!({ "type": "PipeWire:Interface:Port", "info": {
                "direction": direction, "props": { "node.id": node }, "params": { "Latency": latency },
            } })
        };
        let dump = json!([
            link(1, 50),
            link(2, 60), // someone else's stream, on another device
            port(
                50,
                "input",
                json!([
                    { "direction": "Input", "minNs": 313999999.0, "maxNs": 313999999.0, "maxRate": 0.0, "maxQuantum": 0.0 },
                    { "direction": "Output", "maxNs": 0.0 },
                ])
            ),
            port(
                50,
                "output",
                json!([{ "direction": "Input", "maxNs": 900000000.0 }])
            ),
            port(
                60,
                "input",
                json!([{ "direction": "Input", "maxNs": 800000000.0 }])
            ),
        ]);
        let ours = [Stream { serial: 9, node: 1 }];
        assert_eq!(output_delay_ms(&dump, &ours), 313);
        assert_eq!(output_delay_ms(&dump, &[]), 0);
        // Wired devices count in samples and buffers instead.
        let samples = json!([
            link(1, 50),
            port(
                50,
                "input",
                json!([
                    { "direction": "Input", "maxRate": 2400.0, "maxQuantum": 1.0 },
                ])
            )
        ]);
        assert_eq!(output_delay_ms(&samples, &ours), 71);
    }
}

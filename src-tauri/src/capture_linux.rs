//! PipeWire side of the visualizer. Only streams from this process tree are tapped,
//! and pw-record is told not to fall back when one goes away, so it stops instead
//! of opening the microphone.

use super::{Heard, FFT};
use serde_json::Value;
use std::{
    collections::VecDeque,
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

/// Each new track opens a new stream, so the list has to be kept fresh.
const SCAN: Duration = Duration::from_millis(1000);
const MAX_TAPS: usize = 4;
const GRAPH_RATE: f64 = 48_000.0;
const GRAPH_QUANTUM: f64 = 1024.0;
const MAX_OUTPUT_MS: f64 = 1000.0;

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

pub fn available() -> bool {
    ["pw-record", "pw-dump"].iter().all(|tool| {
        Command::new(tool)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    })
}

pub struct Capture {
    targets: Arc<Mutex<(Vec<u64>, u32)>>,
    taps: Vec<Tap>,
}

impl Capture {
    pub fn open(stop: Arc<AtomicBool>) -> Self {
        let targets = Arc::new(Mutex::new((Vec::new(), 0)));
        let found = targets.clone();
        // pw-dump takes long enough to drop a frame, so it runs apart from the drawing.
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if let Some(latest) = scan() {
                    *found.lock().expect("targets") = latest;
                }
                thread::sleep(SCAN);
            }
        });
        Self {
            targets,
            taps: Vec::new(),
        }
    }

    pub(super) fn heard(&mut self) -> Heard {
        let (wanted, output_ms) = self.targets.lock().expect("targets").clone();
        self.taps
            .retain_mut(|t| wanted.contains(&t.serial) && matches!(t.child.try_wait(), Ok(None)));
        for serial in wanted {
            if self.taps.len() < MAX_TAPS && !self.taps.iter().any(|t| t.serial == serial) {
                self.taps.extend(tap(serial));
            }
        }
        // WebKit keeps silent streams open beside the real one.
        let samples = self
            .taps
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
        Heard {
            live: !self.taps.is_empty(),
            samples,
            output_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

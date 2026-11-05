//! PipeWire side of the visualizer. Only streams from this process tree are tapped,
//! and pw-record is told not to fall back when one goes away, so it stops instead
//! of opening the microphone.

use super::{Heard, FFT};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{self, BufReader, Read},
    os::unix::process::CommandExt,
    process::{Child, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

/// How long to wait before starting pw-dump again, as when PipeWire restarts.
const RESTART: Duration = Duration::from_millis(1000);
const MAX_TAPS: usize = 4;
/// A tap that stopped isn't started again for this long, so one that can't work
/// doesn't launch pw-record every frame.
const RETRY: Duration = Duration::from_millis(1000);
/// A tap that has sent nothing for this long isn't hearing anything.
const QUIET: Duration = Duration::from_millis(250);
const GRAPH_RATE: f64 = 48_000.0;
const GRAPH_QUANTUM: f64 = 1024.0;
const MAX_OUTPUT_MS: f64 = 1000.0;
/// What each tap is called in the graph, so it isn't taken for the device.
const TAP_NAME: &str = "sound95-visualizer";

/// Pausing or changing track doesn't change the device, so a delay holds until
/// another is measured. A capture started after a long pause begins with it too.
static OUTPUT_MS: AtomicU32 = AtomicU32::new(0);

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

/// The running playback streams among the graph's objects.
fn our_streams(objects: &[&Value], ours: impl Fn(u32) -> bool) -> Vec<Stream> {
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
/// around 300 ms, and nothing in the audio itself shows it. None when they play
/// on nothing, as when paused or between tracks, which says nothing about the device.
fn output_delay_ms(objects: &[&Value], streams: &[Stream]) -> Option<u32> {
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
    // Our taps are linked to the stream too, but nobody hears through them. A
    // closing stream loses its links one at a time, and once the device's are
    // gone a tap's alone would pass for a device with no delay.
    let taps: Vec<&Value> = objects
        .iter()
        .filter(|o| {
            o["type"] == "PipeWire:Interface:Node" && o["info"]["props"]["node.name"] == TAP_NAME
        })
        .map(|o| &o["id"])
        .collect();
    let devices: Vec<&Value> = infos("PipeWire:Interface:Link")
        .filter(|link| is_ours(&link["output-node-id"]))
        .map(|link| &link["input-node-id"])
        .filter(|node| !taps.contains(node))
        .collect();
    if devices.is_empty() {
        return None;
    }
    let delay = infos("PipeWire:Interface:Port")
        .filter(|port| port["direction"] == "input" && devices.contains(&&port["props"]["node.id"]))
        .flat_map(|port| port["params"]["Latency"].as_array().into_iter().flatten())
        .filter(|latency| latency["direction"] == "Input")
        .map(latency_ms)
        .fold(0.0, f64::max);
    Some(delay.min(MAX_OUTPUT_MS) as u32)
}

fn measured(delay: Option<u32>) {
    if let Some(ms) = delay {
        OUTPUT_MS.store(ms, Ordering::Relaxed);
    }
}

/// The graph as `pw-dump --monitor` tells it, by object id.
#[derive(Default)]
struct Graph(HashMap<u64, Value>);

impl Graph {
    /// A changed object comes whole, and one that's gone comes with a null info.
    /// Metadata has no info at all, so only a null means gone.
    fn apply(&mut self, batch: Value) {
        let Value::Array(objects) = batch else {
            return;
        };
        for object in objects {
            let Some(id) = object["id"].as_u64() else {
                continue;
            };
            if object.get("info").is_some_and(Value::is_null) {
                self.0.remove(&id);
            } else {
                self.0.insert(id, object);
            }
        }
    }

    /// Streams to tap, and the delay of the device they play on.
    fn targets(&self, ours: impl Fn(u32) -> bool) -> (Vec<u64>, Option<u32>) {
        let objects: Vec<&Value> = self.0.values().collect();
        let streams = our_streams(&objects, ours);
        let mut serials: Vec<u64> = streams.iter().map(|s| s.serial).collect();
        serials.sort_unstable();
        (serials, output_delay_ms(&objects, &streams))
    }
}

/// What the capture shares with the thread that follows the graph.
#[derive(Default)]
struct Watch {
    /// Serials of the streams to tap.
    wanted: Mutex<Vec<u64>>,
    /// The running pw-dump, kept here so closing the capture can end it.
    dump: Mutex<Option<Child>>,
    closed: AtomicBool,
}

/// Has the system end `command`'s process if the thread that starts it ends first,
/// as it does when Sound95 crashes or is killed. pw-dump only writes when the audio
/// graph changes, so it can be a long time finding out that nobody's reading.
fn ends_with_this_thread(command: &mut Command) -> &mut Command {
    let parent = std::process::id();
    // SAFETY: this runs between fork and exec, and prctl and getppid are plain
    // system calls that are safe there. Nothing here allocates.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong) != 0 {
                return Err(io::Error::last_os_error());
            }
            // We may have gone before that took hold, and then it never fires.
            if libc::getppid() as u32 != parent {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        })
    }
}

impl Watch {
    /// Starts pw-dump, unless the capture closed meanwhile. It's started from the
    /// thread that follows the graph, which ends it before returning.
    fn start(&self) -> Option<ChildStdout> {
        let mut child = ends_with_this_thread(&mut Command::new("pw-dump"))
            .arg("--monitor")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdout = child.stdout.take();
        let mut dump = self.dump.lock().expect("dump");
        *dump = Some(child);
        if self.closed.load(Ordering::Relaxed) {
            drop(dump);
            self.end();
            return None;
        }
        stdout
    }

    fn end(&self) {
        if let Some(mut child) = self.dump.lock().expect("dump").take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Each new track opens a new stream. pw-dump reports every change as it
    /// happens, so the stream is tapped as soon as it plays, without dumping the
    /// whole graph over and over to look for it.
    fn follow(&self, stop: &AtomicBool) {
        while !stop.load(Ordering::Relaxed) && !self.closed.load(Ordering::Relaxed) {
            if let Some(stdout) = self.start() {
                let mut graph = Graph::default();
                let batches = serde_json::Deserializer::from_reader(BufReader::new(stdout))
                    .into_iter::<Value>();
                for batch in batches.map_while(Result::ok) {
                    graph.apply(batch);
                    let (serials, delay) = graph.targets(is_ours);
                    *self.wanted.lock().expect("wanted") = serials;
                    measured(delay);
                }
                self.end();
                self.wanted.lock().expect("wanted").clear();
            }
            thread::sleep(RESTART);
        }
    }
}

struct Ring {
    samples: VecDeque<f32>,
    /// When pw-record last sent anything.
    fed: Option<Instant>,
}

impl Ring {
    /// A running pw-record proves nothing, as it may never get linked. Even a
    /// silent stream sends zeros, so a tap that sends nothing hears nothing.
    fn hearing(&self, now: Instant) -> bool {
        self.fed.is_some_and(|at| now.duration_since(at) < QUIET)
    }
}

struct Tap {
    serial: u64,
    child: Child,
    ring: Arc<Mutex<Ring>>,
}

impl Drop for Tap {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Newer pw-record writes a .au file to stdout unless told --raw. Older ones
/// write bare samples anyway, but refuse the flag and exit.
fn raw_flag() -> Option<&'static str> {
    static KNOWN: OnceLock<bool> = OnceLock::new();
    let known = *KNOWN.get_or_init(|| {
        Command::new("pw-record")
            .arg("--help")
            .stdin(Stdio::null())
            .output()
            .is_ok_and(|out| mentions_raw(&out.stdout) || mentions_raw(&out.stderr))
    });
    known.then_some("--raw")
}

fn mentions_raw(help: &[u8]) -> bool {
    help.windows(5).any(|w| w == b"--raw")
}

fn tap(serial: u64) -> Option<Tap> {
    let mut child = Command::new("pw-record")
        .arg("--target")
        .arg(serial.to_string())
        .args(["--format", "f32", "--rate", "44100", "--channels", "1"])
        // In samples at --rate, about 23 ms. That still arrives faster than frames
        // are drawn, and anything shorter makes the whole device run smaller,
        // busier cycles.
        .args(["--latency", "1024"])
        .args(raw_flag())
        .arg("-P")
        .arg(format!("{{ node.dont-fallback=true node.dont-reconnect=true node.dont-move=true node.name={TAP_NAME} media.name=Visualizer }}"))
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let ring = Arc::new(Mutex::new(Ring {
        samples: VecDeque::with_capacity(FFT),
        fed: None,
    }));
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
            let mut ring = writer.lock().expect("ring");
            for chunk in buffer[..whole].as_chunks::<4>().0 {
                if ring.samples.len() == FFT {
                    ring.samples.pop_front();
                }
                ring.samples.push_back(f32::from_le_bytes(*chunk));
            }
            ring.fed = Some(Instant::now());
            drop(ring);
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

/// Whether a stream's tap stopped too lately to start another.
fn resting(stopped: &HashMap<u64, Instant>, serial: u64, now: Instant) -> bool {
    stopped
        .get(&serial)
        .is_some_and(|at| now.duration_since(*at) < RETRY)
}

pub struct Capture {
    watch: Arc<Watch>,
    taps: Vec<Tap>,
    /// When each wanted stream's tap last stopped or failed to start.
    stopped: HashMap<u64, Instant>,
}

impl Drop for Capture {
    fn drop(&mut self) {
        // pw-dump only writes when the graph changes, so its reader can't be
        // relied on to notice the capture closing.
        self.watch.closed.store(true, Ordering::Relaxed);
        self.watch.end();
    }
}

impl Capture {
    pub fn open(stop: Arc<AtomicBool>) -> Self {
        let watch = Arc::new(Watch::default());
        let follower = watch.clone();
        // Reading the graph takes long enough to drop a frame, so it runs apart
        // from the drawing.
        thread::spawn(move || follower.follow(&stop));
        Self {
            watch,
            taps: Vec::new(),
            stopped: HashMap::new(),
        }
    }

    pub(super) fn heard(&mut self) -> Heard {
        let wanted = self.watch.wanted.lock().expect("wanted").clone();
        let now = Instant::now();
        let stopped = &mut self.stopped;
        self.taps.retain_mut(|t| {
            let running = matches!(t.child.try_wait(), Ok(None));
            if !running {
                stopped.insert(t.serial, now);
            }
            running && wanted.contains(&t.serial)
        });
        stopped.retain(|serial, _| wanted.contains(serial));
        for serial in wanted {
            if self.taps.len() < MAX_TAPS
                && !self.taps.iter().any(|t| t.serial == serial)
                && !resting(&self.stopped, serial, now)
            {
                match tap(serial) {
                    Some(tap) => self.taps.push(tap),
                    None => {
                        self.stopped.insert(serial, now);
                    }
                }
            }
        }
        // WebKit keeps silent streams open beside the real one.
        let heard: Vec<Vec<f32>> = self
            .taps
            .iter()
            .filter_map(|t| {
                let ring = t.ring.lock().expect("ring");
                ring.hearing(now)
                    .then(|| ring.samples.iter().copied().collect())
            })
            .collect();
        let live = !heard.is_empty();
        let samples = heard
            .into_iter()
            .max_by(|a, b| {
                let energy = |s: &[f32]| s.iter().map(|x| x * x).sum::<f32>();
                energy(a).total_cmp(&energy(b))
            })
            .unwrap_or_default();
        Heard {
            live,
            samples,
            output_ms: OUTPUT_MS.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn all(dump: &Value) -> Vec<&Value> {
        dump.as_array().expect("a listing").iter().collect()
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
        let found = our_streams(&all(&dump), |pid| pid == 10);
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
        assert_eq!(output_delay_ms(&all(&dump), &ours), Some(313));
        // Paused, or between tracks.
        assert_eq!(output_delay_ms(&all(&dump), &[]), None);
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
        assert_eq!(output_delay_ms(&all(&samples), &ours), Some(71));
        // A device that doesn't give its delay adds none.
        assert_eq!(output_delay_ms(&all(&json!([link(1, 50)])), &ours), Some(0));
    }

    #[test]
    fn the_graph_follows_what_pw_dump_reports() {
        let stream = |state: &str| {
            json!({ "id": 7, "type": "PipeWire:Interface:Node", "info": { "state": state, "props": {
                "media.class": "Stream/Output/Audio", "object.serial": 107, "application.process.id": 10,
            } } })
        };
        let link = json!({ "id": 8, "type": "PipeWire:Interface:Link", "info": { "output-node-id": 7, "input-node-id": 50 } });
        let port = json!({ "id": 9, "type": "PipeWire:Interface:Port", "info": {
            "direction": "input", "props": { "node.id": 50 },
            "params": { "Latency": [{ "direction": "Input", "maxNs": 314000000.0 }] },
        } });
        let metadata = json!({ "id": 3, "type": "PipeWire:Interface:Metadata", "metadata": [] });
        let ours = |pid| pid == 10;
        let mut graph = Graph::default();
        graph.apply(json!([stream("idle"), port, metadata]));
        assert_eq!(graph.targets(ours), (vec![], None));
        graph.apply(json!([stream("running"), link]));
        assert_eq!(graph.targets(ours), (vec![107], Some(314)));
        // Both gone again.
        graph.apply(json!([{ "id": 8, "info": null }, { "id": 7, "info": null }]));
        assert_eq!(graph.targets(ours), (vec![], None));
        assert!(graph.0.contains_key(&3) && graph.0.contains_key(&9));
        graph.apply(json!({ "not": "a batch" }));
        assert_eq!(graph.0.len(), 2);
    }

    #[test]
    fn a_closing_stream_keeps_the_delay() {
        let ours = |pid| pid == 10;
        let mut graph = Graph::default();
        graph.apply(json!([
            { "id": 7, "type": "PipeWire:Interface:Node", "info": { "state": "running", "props": {
                "media.class": "Stream/Output/Audio", "object.serial": 107, "application.process.id": 10,
            } } },
            { "id": 8, "type": "PipeWire:Interface:Link", "info": { "output-node-id": 7, "input-node-id": 50 } },
            { "id": 9, "type": "PipeWire:Interface:Port", "info": {
                "direction": "input", "props": { "node.id": 50 },
                "params": { "Latency": [{ "direction": "Input", "maxNs": 314000000.0 }] },
            } },
            { "id": 20, "type": "PipeWire:Interface:Node", "info": { "state": "running", "props": {
                "media.class": "Stream/Input/Audio", "node.name": TAP_NAME,
            } } },
            { "id": 21, "type": "PipeWire:Interface:Link", "info": { "output-node-id": 7, "input-node-id": 20 } },
            { "id": 22, "type": "PipeWire:Interface:Port", "info": {
                "direction": "input", "props": { "node.id": 20 },
                "params": { "Latency": [{ "direction": "Input", "maxNs": 0.0 }] },
            } },
        ]));
        assert_eq!(graph.targets(ours), (vec![107], Some(314)));
        // PipeWire takes a closing stream's links down one at a time while the
        // stream still reads as running, and the device's can go before the tap's.
        graph.apply(json!([{ "id": 8, "info": null }]));
        assert_eq!(graph.targets(ours), (vec![107], None));
    }

    #[test]
    fn raw_output_is_asked_for_only_where_pw_record_knows_it() {
        let older = b"      --volume                          Stream volume 0-1.0 (default 1.000)\n  -q  --quality                         Resampler quality (0 - 15) (default 4)\n";
        let newer = b"  -q  --quality                         Resampler quality (0 - 15) (default 4)\n  -a, --raw                             RAW mode\n";
        assert!(!mentions_raw(older));
        assert!(mentions_raw(newer));
    }

    #[test]
    fn a_stopped_tap_waits_before_it_starts_again() {
        let now = Instant::now();
        let stopped = HashMap::from([(7, now)]);
        assert!(resting(&stopped, 7, now + RETRY / 2));
        assert!(!resting(&stopped, 7, now + RETRY));
        assert!(!resting(&stopped, 8, now));
    }

    #[test]
    fn only_a_tap_that_sends_audio_is_live() {
        let now = Instant::now();
        let ring = |fed| Ring {
            samples: VecDeque::new(),
            fed,
        };
        assert!(!ring(None).hearing(now));
        assert!(ring(Some(now)).hearing(now + QUIET / 2));
        assert!(!ring(Some(now)).hearing(now + QUIET));
    }

    #[test]
    fn the_delay_holds_while_nothing_plays() {
        measured(Some(314));
        measured(None);
        assert_eq!(OUTPUT_MS.load(Ordering::Relaxed), 314);
        measured(Some(20));
        assert_eq!(OUTPUT_MS.load(Ordering::Relaxed), 20);
    }

    #[test]
    fn a_watcher_does_not_outlive_the_thread_that_started_it() {
        use std::os::unix::process::ExitStatusExt;
        let started = thread::spawn(|| {
            ends_with_this_thread(Command::new("sleep").arg("10"))
                .stdin(Stdio::null())
                .spawn()
                .expect("sleep")
        });
        // The thread is gone once it has been joined, without having ended sleep.
        let mut child = started.join().expect("thread");
        let begun = Instant::now();
        let status = child.wait().expect("wait");
        assert_eq!(status.signal(), Some(libc::SIGTERM));
        assert!(begun.elapsed() < Duration::from_secs(5));
    }
}

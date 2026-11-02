//! WASAPI side of the visualizer. Process loopback (Windows 10 2004 and later)
//! delivers only what this process and its children play, WebView2 being one, and
//! never touches a microphone. Windows doesn't report a Bluetooth headset's delay,
//! so the output delay stays at zero.

use super::{Heard, FFT, RATE, SILENCE};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const CHANNELS: usize = 2;
const FRAME_BYTES: usize = 4 * CHANNELS;
/// With no packets for this long, nothing is playing.
const QUIET_MS: u32 = 200;

pub fn available() -> bool {
    true
}

pub struct Capture {
    live: Arc<AtomicBool>,
    ring: Arc<Mutex<VecDeque<f32>>>,
}

impl Capture {
    pub fn open(stop: Arc<AtomicBool>) -> Self {
        let live = Arc::new(AtomicBool::new(false));
        let ring = Arc::new(Mutex::new(VecDeque::with_capacity(FFT)));
        let (flag, writer) = (live.clone(), ring.clone());
        thread::spawn(move || {
            // Older Windows can't do this, and the page falls back to the waveform.
            let _ = listen(&flag, &writer, &stop);
            flag.store(false, Ordering::Relaxed);
        });
        Self { live, ring }
    }

    pub(super) fn heard(&mut self) -> Heard {
        Heard {
            live: self.live.load(Ordering::Relaxed),
            samples: self.ring.lock().expect("ring").iter().copied().collect(),
            output_ms: 0,
        }
    }
}

fn listen(
    live: &AtomicBool,
    ring: &Mutex<VecDeque<f32>>,
    stop: &AtomicBool,
) -> Result<(), Box<dyn std::error::Error>> {
    initialize_mta().ok()?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, RATE as usize, CHANNELS, None);
    let mut client = AudioClient::new_application_loopback_client(std::process::id(), true)?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    client.initialize_client(&format, &Direction::Capture, &mode)?;
    let event = client.set_get_eventhandle()?;
    let packets = client.get_audiocaptureclient()?;
    client.start_stream()?;

    let mut bytes = VecDeque::new();
    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(QUIET_MS).is_err() {
            live.store(false, Ordering::Relaxed);
            ring.lock().expect("ring").clear();
            continue;
        }
        packets.read_from_device_to_deque(&mut bytes)?;
        let whole = bytes.len() - bytes.len() % FRAME_BYTES;
        let frames: Vec<u8> = bytes.drain(..whole).collect();
        let mut loudest: f32 = 0.0;
        let mut samples = ring.lock().expect("ring");
        for frame in frames.as_chunks::<FRAME_BYTES>().0 {
            if samples.len() == FFT {
                samples.pop_front();
            }
            let value = (sample(&frame[..4]) + sample(&frame[4..])) / 2.0;
            loudest = loudest.max(value.abs());
            samples.push_back(value);
        }
        // Windows can send silence for a process that isn't playing, so packets
        // alone don't prove we can hear it. A real gap in a song is short, and the
        // page waits a few seconds before giving up.
        live.store(loudest > SILENCE, Ordering::Relaxed);
    }
    client.stop_stream()?;
    Ok(())
}

fn sample(bytes: &[u8]) -> f32 {
    f32::from_le_bytes(bytes.try_into().expect("four bytes"))
}

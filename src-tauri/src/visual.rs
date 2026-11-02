//! Live audio for the visualizer. Sound plays inside SoundCloud's cross-origin
//! Widget, where the page can't read it, so the system hands us the app's own
//! output and this turns it into frequency bands.

use serde::Serialize;
use std::{
    f32::consts::PI,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[cfg_attr(target_os = "linux", path = "capture_linux.rs")]
#[cfg_attr(windows, path = "capture_windows.rs")]
mod capture;

const BANDS: usize = 32;
const WAVE: usize = 96;
const FFT: usize = 2048;
const RATE: f32 = 44_100.0;
const LOW_HZ: f32 = 50.0;
const HIGH_HZ: f32 = 16_000.0;
const FRAME: Duration = Duration::from_millis(33);
/// Quieter than this is treated as nothing playing.
const SILENCE: f32 = 1e-6;
/// How far below the recent peak still shows, in dB.
const RANGE: f32 = 54.0;
/// The peak falls this much per frame, which works out to 3 dB a second.
const PEAK_FALL: f32 = 0.1;
/// Music is quieter the higher it goes, so highs get lifted to fill the display.
const TILT_PER_OCTAVE: f32 = 3.0;
const EVENT: &str = "sound95:visual";

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

/// What the app is playing right now.
struct Heard {
    /// False when nothing could be tapped, so the samples mean nothing.
    live: bool,
    samples: Vec<f32>,
    output_ms: u32,
}

fn run(app: AppHandle, stop: Arc<AtomicBool>) {
    let mut capture = capture::Capture::open(stop.clone());
    let mut analyser = Analyser::new();
    while !stop.load(Ordering::Relaxed) {
        let heard = capture.heard();
        let (bands, wave, level) = analyser.frame(&heard.samples);
        let frame = Frame {
            live: heard.live,
            bands,
            wave,
            level,
            output_ms: heard.output_ms,
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
        if !capture::available() {
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
}

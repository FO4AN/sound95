// Smooth animations, in the style of macOS, for the Modern skin. Windows 95 had
// none, so Classic stays instant. The CSS is in modern.css, under data-motion="on";
// this decides when that's set and lets things animate on their way out.

// Saved only when animations are turned on or off in Settings.
const KEY = 'sound95.motionChoice';
// 0.6.0 saved this on every start, as if it had been chosen, so it says nothing
// about what anyone wants and would keep the system's reduced motion setting out.
const OLD_KEY = 'sound95.motion';
const SPEED_KEY = 'sound95.motionSpeed';

try { localStorage.removeItem(OLD_KEY); } catch { /* optional */ }

export const SPEEDS = { slow: 1.6, normal: 1, fast: 0.6 };

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function motionOn() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved == null ? !reduced() : saved === '1';
  } catch { return !reduced(); }
}

export function motionSpeed() {
  try {
    const saved = localStorage.getItem(SPEED_KEY);
    return saved in SPEEDS ? saved : 'normal';
  } catch { return 'normal'; }
}

/** True while things on screen animate. */
export const animating = () => document.documentElement.dataset.motion === 'on';

/**
 * Sets up animations, and saves `on` and `speed` when they're given. Until you choose,
 * the system's reduced motion setting decides, each time Sound95 starts.
 */
export function applyMotion({ on, speed } = {}) {
  try {
    if (on != null) localStorage.setItem(KEY, on ? '1' : '0');
    if (speed != null) localStorage.setItem(SPEED_KEY, speed);
  } catch { /* optional */ }
  on ??= motionOn();
  speed ??= motionSpeed();
  const root = document.documentElement;
  const animates = on && root.dataset.skin === 'modern';
  root.dataset.motion = animates ? 'on' : 'off';
  root.style.setProperty('--speed', String(SPEEDS[speed] ?? 1));
  // Whatever was on its way out has no animation left to finish, so it goes now.
  if (!animates) document.querySelectorAll('.leaving').forEach((node) => node.remove());
}

/**
 * Removes `node`, after its exit animation when there is one. It stops taking
 * clicks straight away, so nothing lands on something that's already going.
 */
export function leave(node) {
  if (!node?.isConnected) return;
  if (!animating()) { node.remove(); return; }
  node.classList.add('leaving');
  node.inert = true;
  let gone = false;
  const finish = () => { if (!gone) { gone = true; node.remove(); } };
  node.addEventListener('animationend', (e) => { if (e.target === node) finish(); });
  setTimeout(finish, 500 * (SPEEDS[motionSpeed()] ?? 1));
}

/** Runs `change` as a cross-fade where the system can, or straight away. */
export function crossfade(change) {
  if (animating() && document.startViewTransition) document.startViewTransition(change);
  else change();
}

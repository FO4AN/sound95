// Tiny DOM builder. Everything from SoundCloud goes in as text, never as HTML.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

export function clear(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter(Boolean));
}

/** Runs `fn` on each event from `subscribe`, until `node` has left the page. */
export function whileShown(node, subscribe, fn) {
  let shown = false;
  const stop = subscribe(() => {
    if (node.isConnected) {
      shown = true;
      fn();
    } else if (shown) {
      stop();
    }
  });
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function fmtCount(n) {
  if (n == null) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

let statusTimer;
export function setStatus(text, { sticky = false } = {}) {
  const node = document.getElementById('status');
  node.textContent = text;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => { node.textContent = 'Ready'; }, 6000);
}

export function errorText(e) {
  if (e?.code === 'rate_limited') {
    return e.retry_after ? `SoundCloud rate limit reached. Try again in ${e.retry_after}s.` : e.message;
  }
  return e?.message || String(e);
}

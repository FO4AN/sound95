// Colour schemes and the two skins. Classic is Windows 95 in one of its schemes;
// Modern lays the same app out like a current music player. The colours live in
// win95.css and modern.css, keyed by `data-theme` on the page.

import { refreshIcons } from './icons.js';
import { applyMotion } from './motion.js';

const STORE_KEY = 'sound95.theme';

export const THEMES = [
  { id: 'light', label: 'Light', skin: 'classic' },
  { id: 'dark', label: 'Dark', skin: 'classic' },
  { id: 'desert', label: 'Desert', skin: 'classic' },
  { id: 'eggplant', label: 'Eggplant', skin: 'classic' },
  { id: 'rainy', label: 'Rainy Day', skin: 'classic' },
  { id: 'rose', label: 'Rose', skin: 'classic' },
  { id: 'spruce', label: 'Spruce', skin: 'classic' },
  { id: 'contrast', label: 'High Contrast', skin: 'classic' },
  { id: 'modern', label: 'Modern Dark', skin: 'modern' },
  { id: 'modern-light', label: 'Modern Light', skin: 'modern' },
];

const byId = (id) => THEMES.find((t) => t.id === id);
const listeners = new Set();

export function savedTheme() {
  try { return byId(localStorage.getItem(STORE_KEY))?.id || 'light'; } catch { return 'light'; }
}

export const currentSkin = () => document.documentElement.dataset.skin || 'classic';
export const onSkinChange = (fn) => listeners.add(fn);

export function applyTheme(id = savedTheme()) {
  const theme = byId(id) || byId('light');
  const root = document.documentElement;
  const skinChanged = root.dataset.skin !== theme.skin;
  root.dataset.theme = theme.id;
  root.dataset.skin = theme.skin;
  try { localStorage.setItem(STORE_KEY, theme.id); } catch { /* optional */ }
  applyMotion();
  if (!skinChanged) return;
  // Modern has no title bar, so the empty parts of its top row move the window.
  for (const node of document.querySelectorAll('#menubar, .toolbar')) {
    node.toggleAttribute('data-tauri-drag-region', theme.skin === 'modern');
  }
  refreshIcons();
  listeners.forEach((fn) => fn(theme.skin));
}

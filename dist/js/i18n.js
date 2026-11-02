// The app's languages. English is written directly in the code, so `tr` looks up the
// English text and falls back to it, which keeps a missing translation readable.

import ru from './lang/ru.js';
import uk from './lang/uk.js';
import es from './lang/es.js';
import de from './lang/de.js';
import fr from './lang/fr.js';

const STORE_KEY = 'sound95.language';

export const LANGUAGES = {
  en: { name: 'English', strings: {} },
  ru: { name: 'Русский', strings: ru },
  uk: { name: 'Українська', strings: uk },
  es: { name: 'Español', strings: es },
  de: { name: 'Deutsch', strings: de },
  fr: { name: 'Français', strings: fr },
};

function savedLanguage() {
  try {
    const code = localStorage.getItem(STORE_KEY);
    return LANGUAGES[code] ? code : 'en';
  } catch { return 'en'; }
}

let language = savedLanguage();
const listeners = new Set();

export const currentLanguage = () => language;
export const onLanguageChange = (fn) => listeners.add(fn);

/** `{name}` in the text is filled in from `values`. */
export function tr(text, values) {
  const found = LANGUAGES[language].strings[text] ?? text;
  if (!values) return found;
  return found.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole));
}

/** Fills in the parts of index.html that are marked for translation. */
export function translatePage() {
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = tr(node.dataset.t);
  for (const node of document.querySelectorAll('[data-hint]')) node.placeholder = tr(node.dataset.hint);
  for (const node of document.querySelectorAll('[data-tip]')) {
    const text = tr(node.dataset.tip);
    if (node.hasAttribute('title')) node.title = text;
    if (node.hasAttribute('aria-label')) node.setAttribute('aria-label', text);
  }
}

export function setLanguage(code) {
  if (code === language || !LANGUAGES[code]) return;
  language = code;
  try { localStorage.setItem(STORE_KEY, code); } catch { /* optional */ }
  translatePage();
  listeners.forEach((fn) => fn());
}

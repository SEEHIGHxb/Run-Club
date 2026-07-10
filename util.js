// ============================================================================
//  Runaway · Shared helpers
//  Pure utilities with no app state: DOM shorthand, formatters, HTML
//  escaping/sanitising, and small UI conveniences shared by every module.
// ============================================================================

export const $ = (sel) => document.querySelector(sel);

export function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function rangeCutoff(r) {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const local = new Date(now.getTime() - off * 60000);
  if (r === 'all') return null;
  if (r === 'month') {
    return local.toISOString().slice(0, 7) + '-01';
  }
  const day = (local.getUTCDay() + 6) % 7;
  const monday = new Date(local.getTime() - day * 86400000);
  return monday.toISOString().slice(0, 10);
}

export function paceLabel(km, min) {
  const d = Number(km);
  const m = Number(min);
  if (!(d > 0) || !(m > 0)) return '';
  const pace = m / d;
  const mm = Math.floor(pace);
  const ss = Math.round((pace - mm) * 60);
  const ssStr = ss === 60 ? '00' : String(ss).padStart(2, '0');
  return `${ss === 60 ? mm + 1 : mm}:${ssStr}/km`;
}

export function fmtKm(km) {
  const n = Number(km);
  return (Number.isInteger(n) ? n : Number(n.toFixed(2))) + ' km';
}

export function fmtDuration(min) {
  const m = Number(min);
  if (m < 60) return `${m % 1 === 0 ? m : m.toFixed(1)} min`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return `${h}h ${rem}m`;
}

export function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function formatDisplayName(name) {
  if (!name) return 'Anonymous';
  const trimmed = name.trim();
  if (trimmed.length > 15) {
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex !== -1) {
      const firstName = trimmed.substring(0, spaceIndex);
      const surname = trimmed.substring(spaceIndex + 1).trim();
      if (surname.length > 0) {
        return `${firstName} ${surname[0].toUpperCase()}.`;
      }
    }
  }
  return trimmed;
}

// Sanitize a user-supplied avatar URL before it goes into an <img src> template.
// Only http(s) URLs pass; anything else (javascript:, attribute-breakout
// payloads, etc.) becomes empty so the <img> is simply omitted. Callers must
// still escapeHtml() the result to neutralise quotes in an otherwise valid URL.
export function safeUrl(u) {
  if (!u) return '';
  try {
    const parsed = new URL(u, window.location.href);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch {
    return '';
  }
}

// Render an avatar <img> tag from an untrusted URL, or '' when there's none.
export function avatarImg(url, attrs = '') {
  const safe = safeUrl(url);
  return safe ? `<img class="avatar"${attrs} src="${escapeHtml(safe)}">` : '';
}

// Copy an input's value to the clipboard and flash "Copied!" on the trigger
// button. Shared by the friend-link and club-link copy buttons.
export function copyInputToClipboard(inputSel, btnSel) {
  const linkEl = $(inputSel);
  linkEl.select();
  linkEl.setSelectionRange(0, 99999);
  try {
    navigator.clipboard.writeText(linkEl.value);
  } catch (_) {
    // Older/non-secure contexts: the text is already selected for manual copy.
    document.execCommand && document.execCommand('copy');
  }

  const btn = $(btnSel);
  const origText = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = origText; }, 2000);
}

// ============================================================================
//  Run Club — Activity file parser
//  Parses an uploaded workout file (.fit / .tcx / .gpx) entirely in the
//  browser and returns a normalized summary: { distanceKm, durationMin,
//  dateISO }. Consumed by app.js. FIT (Garmin's binary format) uses Garmin's
//  official SDK, imported on demand so it never slows the initial page load.
//  Works for Garmin, Apple Watch, Coros, Strava exports, etc.
// ============================================================================

const EARTH_RADIUS_M = 6371000;

// Public entry point. Detects format by file extension and dispatches.
// Throws a user-friendly Error if the file can't be read.
export async function parseActivityFile(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.fit')) return parseFit(file);
  if (name.endsWith('.tcx')) return parseTcx(await file.text());
  if (name.endsWith('.gpx')) return parseGpx(await file.text());
  throw new Error('Unsupported file. Upload a .fit, .tcx, or .gpx file.');
}

// ---------------------------------------------------------------------------
//  FIT (binary) — Garmin's native format
// ---------------------------------------------------------------------------
async function parseFit(file) {
  const { Decoder, Stream } = await import('https://esm.sh/@garmin/fitsdk');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stream = Stream.fromByteArray(bytes);
  if (!Decoder.isFIT(stream)) throw new Error('That .fit file looks corrupted.');

  const decoder = new Decoder(stream);
  const { messages } = decoder.read();

  // The `session` message holds the workout summary Garmin computes on-device.
  const session = (messages.sessionMesgs || [])[0];
  const distanceM = session?.totalDistance;
  const durationS = session?.totalTimerTime ?? session?.totalElapsedTime;
  const start = session?.startTime;

  if (distanceM == null) throw new Error('No distance found in this .fit file.');
  return normalize(distanceM, durationS, start);
}

// ---------------------------------------------------------------------------
//  TCX — XML with pre-computed lap distances/times
// ---------------------------------------------------------------------------
function parseTcx(text) {
  const doc = parseXml(text, 'TCX');
  const laps = tags(doc, 'Lap');

  let distanceM = 0;
  let durationS = 0;
  for (const lap of laps) {
    distanceM += num(text1(lap, 'DistanceMeters')); // first = the lap total
    durationS += num(text1(lap, 'TotalTimeSeconds'));
  }

  // Fallback: use the final trackpoint's cumulative distance.
  if (!distanceM) {
    const dps = tags(doc, 'DistanceMeters');
    if (dps.length) distanceM = num(dps[dps.length - 1].textContent);
  }

  if (!distanceM) throw new Error('No distance found in this .tcx file.');
  return normalize(distanceM, durationS || null, firstTcxTime(doc));
}

function firstTcxTime(doc) {
  const lap = tags(doc, 'Lap')[0];
  const start = lap && lap.getAttribute('StartTime');
  if (start) return start;
  return text1(doc, 'Id') || (tags(doc, 'Time')[0]?.textContent ?? null);
}

// ---------------------------------------------------------------------------
//  GPX — GPS track only; distance is computed from coordinates
// ---------------------------------------------------------------------------
function parseGpx(text) {
  const doc = parseXml(text, 'GPX');
  const pts = tags(doc, 'trkpt');
  if (pts.length < 2) throw new Error('No GPS track found in this .gpx file.');

  let distanceM = 0;
  let prev = null;
  let firstT = null;
  let lastT = null;
  for (const p of pts) {
    const lat = parseFloat(p.getAttribute('lat'));
    const lon = parseFloat(p.getAttribute('lon'));
    if (prev && Number.isFinite(lat) && Number.isFinite(lon)) {
      distanceM += haversine(prev.lat, prev.lon, lat, lon);
    }
    if (Number.isFinite(lat) && Number.isFinite(lon)) prev = { lat, lon };

    const t = text1(p, 'time');
    if (t) { if (!firstT) firstT = t; lastT = t; }
  }

  let durationS = null;
  if (firstT && lastT) {
    const secs = (new Date(lastT) - new Date(firstT)) / 1000;
    if (secs > 0) durationS = secs;
  }
  if (!distanceM) throw new Error('Could not measure distance from this .gpx file.');
  return normalize(distanceM, durationS, firstT);
}

// Great-circle distance between two lat/lon points, in metres.
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
//  Shared helpers
// ---------------------------------------------------------------------------
function normalize(distanceM, durationS, start) {
  return {
    distanceKm: Math.round((distanceM / 1000) * 100) / 100,
    durationMin: durationS != null ? Math.round((durationS / 60) * 10) / 10 : null,
    dateISO: start ? toLocalISODate(start) : null,
  };
}

// Convert a Date or ISO string to a local-time YYYY-MM-DD string.
function toLocalISODate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function parseXml(text, label) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error(`Could not read this ${label} file — it may be corrupted.`);
  }
  return doc;
}

// Namespace-agnostic element lookup (TCX/GPX use default namespaces).
function tags(root, name) {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function text1(root, name) {
  const el = root.getElementsByTagNameNS('*', name)[0];
  return el ? el.textContent.trim() : '';
}

function num(s) {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

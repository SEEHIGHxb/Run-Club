// ============================================================================
//  Runaway · Strava-style Stat and Leaderboard Sharing manager
//  Utilizes html2canvas to render high-resolution 1080p cards off-screen
//  and connects to the Web Share API and canvas download operations.
// ============================================================================

import { $, escapeHtml, fmtKm, fmtDuration, paceLabel, fmtDate, safeUrl } from './util.js';

let html2canvasModule = null;

const CARD_WIDTH = 1080;

// Safe single-letter avatar fallback: escaped so a name starting with `<`/`&`
// can't corrupt the card markup, and never throws on an empty/whitespace name
// (a bare `name[0]` on '' is undefined → .toUpperCase() would crash the render).
function initial(name) {
  const s = (name || '').trim();
  return s ? escapeHtml(s[0].toUpperCase()) : '?';
}

// Hard character budget for free text on the card. html2canvas 1.4.1 does not
// honour -webkit-line-clamp, so CSS clamping would look right in the preview and
// then overflow in the exported PNG — trimming the string is the only fix that
// holds for both.
function truncate(text, max) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// Split the distance so the number can be set as a hero figure and the unit as a
// smaller suffix. Mirrors fmtKm's rounding so the card never disagrees with the
// rest of the app.
function kmParts(km) {
  const n = Number(km);
  if (!Number.isFinite(n)) return { value: '0', unit: 'km' };
  return { value: String(Number.isInteger(n) ? n : Number(n.toFixed(2))), unit: 'km' };
}

// Match the preview scale to the frame's measured width. The frame's aspect
// ratio always equals the card's, so scaling by width alone fills it exactly in
// both 9:16 and 1:1 — no letterboxing, no clipping, at any viewport size.
function fitPreview() {
  const frame = document.querySelector('.share-preview-frame');
  if (!frame) return;
  const width = frame.clientWidth;
  if (!width) return;
  frame.style.setProperty('--preview-scale', String(width / CARD_WIDTH));
}

// Dynamic loader for html2canvas to optimize startup performance
async function getHtml2Canvas() {
  if (html2canvasModule) return html2canvasModule;
  try {
    const module = await import('https://esm.sh/html2canvas@1.4.1');
    html2canvasModule = module.default;
    return html2canvasModule;
  } catch (err) {
    console.error('Failed to import html2canvas:', err);
    throw new Error('Could not load card renderer. Please check your network connection.');
  }
}

// Share state
let shareTargetData = null; // { type: 'run', run: [...] } or { type: 'leaderboard', clubName: '...', range: '...', ranked: [...] }
let shareRatio = 'story';   // story (9:16) | post (1:1)
let shareTheme = 'sunrise'; // sunrise | carbon | electric | forest

export function initShare() {
  const modal = $('#share-modal');
  if (!modal) return;

  // Bind close buttons
  $('#btn-share-close').addEventListener('click', () => { modal.hidden = true; });
  
  // Ratio switches
  $('#btn-share-ratio-story').addEventListener('click', () => {
    shareRatio = 'story';
    $('#btn-share-ratio-story').classList.add('active');
    $('#btn-share-ratio-post').classList.remove('active');
    $('.share-preview-frame').classList.remove('post-ratio');
    updateSharePreview();
  });
  
  $('#btn-share-ratio-post').addEventListener('click', () => {
    shareRatio = 'post';
    $('#btn-share-ratio-post').classList.add('active');
    $('#btn-share-ratio-story').classList.remove('active');
    $('.share-preview-frame').classList.add('post-ratio');
    updateSharePreview();
  });

  // Theme dot clicks
  document.querySelectorAll('.theme-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      document.querySelectorAll('.theme-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      shareTheme = dot.dataset.theme;
      updateSharePreview();
    });
  });

  // Share triggers. One honest "Share" action: the destination (Instagram
  // Story / Feed / Direct, WhatsApp, Messages…) is chosen in the OS share sheet,
  // not here — the web has no API to target a specific Instagram surface.
  $('#btn-share-native').addEventListener('click', triggerShare);
  $('#btn-share-download').addEventListener('click', triggerDownload);

  // Dismiss when the backdrop (outside the card) is clicked.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  // Close on Escape, matching the backdrop click. Bound on document because the
  // modal itself never holds focus.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  // Re-fit whenever the frame's width changes: opening the modal, switching
  // ratio, rotating the phone, or the on-screen keyboard resizing the viewport.
  const frame = $('.share-preview-frame');
  if (frame && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(fitPreview).observe(frame);
  } else {
    window.addEventListener('resize', fitPreview);
  }
}

export function openShareRun(run) {
  shareTargetData = { type: 'run', run };
  shareRatio = 'story';
  shareTheme = 'sunrise';

  // Reset buttons
  $('#btn-share-ratio-story').classList.add('active');
  $('#btn-share-ratio-post').classList.remove('active');
  $('.share-preview-frame').classList.remove('post-ratio');
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.theme === 'sunrise');
  });

  // Unhide first: fitPreview measures the frame, and a hidden frame measures 0,
  // which would leave the card on the fallback scale until the ResizeObserver
  // caught up — a visible flash of a wrongly-sized preview on every open.
  $('#share-modal').hidden = false;
  updateSharePreview();
}

export function openShareLeaderboard(clubName, range, ranked) {
  shareTargetData = { type: 'leaderboard', clubName, range, ranked };
  shareRatio = 'story';
  shareTheme = 'sunrise';

  // Reset buttons
  $('#btn-share-ratio-story').classList.add('active');
  $('#btn-share-ratio-post').classList.remove('active');
  $('.share-preview-frame').classList.remove('post-ratio');
  document.querySelectorAll('.theme-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.theme === 'sunrise');
  });

  // Unhide before measuring — see the note in openShareRun.
  $('#share-modal').hidden = false;
  updateSharePreview();
}

// Generate the HTML template for the card
function buildCardHtml(renderRatio, renderTheme) {
  if (!shareTargetData) return '';

  const ratioClass = renderRatio === 'post' ? ' post-format' : '';
  const themeClass = ` share-theme-${renderTheme}`;
  const isLeaderboard = shareTargetData.type === 'leaderboard';

  let contentHtml = '';

  const isPost = renderRatio === 'post';

  if (isLeaderboard) {
    const { clubName, range, ranked } = shareTargetData;
    const rangeLabel = range === 'week' ? 'This Week' : range === 'month' ? 'This Month' : 'All Time';

    // The 1:1 Post has roughly half the vertical room of a 9:16 Story, so it
    // shows a shorter podium rather than shrinking every row until it is
    // unreadable at feed size.
    const topRanked = ranked.slice(0, isPost ? 4 : 6);
    const listItems = topRanked.map((row, index) => {
      // Sanitize the avatar URL the same way the rest of the app does (safeUrl),
      // then escape it for the attribute; fall back to a safe initial otherwise.
      const safeAvatar = safeUrl(row.avatar);
      const avatarHtml = safeAvatar
        ? `<img class="card-leaderboard-avatar" src="${escapeHtml(safeAvatar)}" crossorigin="anonymous">`
        : `<div class="card-leaderboard-avatar card-avatar-fallback" style="font-size:36px;">${initial(row.name)}</div>`;

      return `
        <li class="card-leaderboard-row${index === 0 ? ' is-leader' : ''}">
          <span class="card-leaderboard-rank">${index + 1}</span>
          ${avatarHtml}
          <span class="card-leaderboard-name">${escapeHtml(truncate(row.name, isPost ? 14 : 18))}</span>
          <span class="card-leaderboard-km">${fmtKm(row.km)}</span>
        </li>
      `;
    }).join('');

    contentHtml = `
      <div class="card-header-brand">
        <div>
          <div class="card-eyebrow">Club leaderboard · ${rangeLabel}</div>
          <div class="card-runner-name" style="margin-top:10px;">${escapeHtml(truncate(clubName, 22))}</div>
        </div>
        <img class="card-logo" src="./icons/runorlose.png" alt="Logo">
      </div>

      <ul class="card-leaderboard-list">
        ${listItems}
      </ul>
    `;
  } else {
    // Single Run
    const { run } = shareTargetData;
    const runnerName = run.profiles?.display_name || 'Runner';
    const safeAvatar = safeUrl(run.profiles?.avatar_url);
    const pace = paceLabel(run.distance_km, run.duration_min);
    const distance = kmParts(run.distance_km);

    const avatarHtml = safeAvatar
      ? `<img class="card-runner-avatar" src="${escapeHtml(safeAvatar)}" crossorigin="anonymous">`
      : `<div class="card-runner-avatar card-avatar-fallback" style="font-size:42px;">${initial(runnerName)}</div>`;

    // Duration and pace drop to equal-weight tiles below the hero figure; the
    // strip is omitted entirely when a run has neither, so the card never shows
    // an empty container.
    const metrics = [];
    if (run.duration_min) metrics.push({ label: 'Time', value: fmtDuration(run.duration_min) });
    if (pace) metrics.push({ label: 'Pace', value: pace });
    const metricsHtml = metrics.length
      ? `<div class="card-metrics">${metrics.map((m) => `
          <div class="card-metric">
            <span class="card-metric-label">${m.label}</span>
            <span class="card-metric-value">${escapeHtml(m.value)}</span>
          </div>`).join('')}</div>`
      : '';

    const notes = truncate(run.notes, isPost ? 90 : 150);
    const notesHtml = notes ? `<div class="card-notes">“${escapeHtml(notes)}”</div>` : '';

    contentHtml = `
      <div class="card-header-brand">
        <div class="card-runner-profile">
          ${avatarHtml}
          <div style="min-width:0;">
            <div class="card-runner-name">${escapeHtml(truncate(runnerName, 20))}</div>
            <div class="card-eyebrow" style="margin-top:8px;">Logged a run</div>
          </div>
        </div>
        <img class="card-logo" src="./icons/runorlose.png" alt="Logo">
      </div>

      <div class="card-hero">
        <span class="card-eyebrow">Distance</span>
        <div class="card-hero-value">
          ${escapeHtml(distance.value)}<span class="card-hero-unit">${distance.unit}</span>
        </div>
      </div>

      ${metricsHtml}
      ${notesHtml}
    `;
  }

  const dateText = shareTargetData.type === 'run' ? fmtDate(shareTargetData.run.run_date) : fmtDate(new Date().toISOString().slice(0,10));

  return `
    <div class="share-card-layout${ratioClass}${themeClass}">
      ${contentHtml}
      <div class="card-footer">
        <span class="card-footer-logo-text">RUNAWAY</span>
        <span class="card-footer-date">${dateText}</span>
      </div>
    </div>
  `;
}

function updateSharePreview() {
  const container = $('#share-preview-render');
  if (!container) return;
  
  container.innerHTML = buildCardHtml(shareRatio, shareTheme);
  container.style.height = shareRatio === 'post' ? '1080px' : '1920px';
  fitPreview();
}

// Generate image using html2canvas
async function generateCardBlob() {
  const renderContainer = $('#share-render-container');
  if (!renderContainer) return null;

  // Render the card HTML at full 1080p in the off-screen container
  renderContainer.innerHTML = buildCardHtml(shareRatio, shareTheme);
  
  // Apply explicit styling to match card sizing
  const cardElement = renderContainer.querySelector('.share-card-layout');
  if (!cardElement) return null;

  try {
    const html2canvas = await getHtml2Canvas();
    const canvas = await html2canvas(cardElement, {
      useCORS: true,           // allow fetching cross-origin images (avatars)
      allowTaint: false,       // do not taint the canvas
      scale: 1,                // capture at exactly 1:1 pixel scale (1080p)
      width: 1080,
      height: shareRatio === 'post' ? 1080 : 1920,
      backgroundColor: null,
      logging: false,
    });
    
    // Clear off-screen render area
    renderContainer.innerHTML = '';

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(blob);
      }, 'image/png', 0.95);
    });
  } catch (err) {
    console.error('Failed to generate image:', err);
    renderContainer.innerHTML = '';
    throw err;
  }
}

// Render the card and hand it to the OS share sheet, where the user picks the
// real destination (Instagram Story / Feed / Direct, WhatsApp, Messages…).
// There is deliberately no per-destination branching or `instagram://` deep
// link: a web page can't drop an image straight into a specific Instagram
// surface, and the old deep links (`instagram://camera` etc.) opened the app
// without the card. Browsers that can't share files (mostly desktop) get an
// honest download fallback instead.
async function triggerShare() {
  const btn = $('#btn-share-native');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Generating image…';

  try {
    const blob = await generateCardBlob();
    if (!blob) throw new Error('Could not render image.');

    const filename = `runaway_${shareTargetData.type}_${Date.now()}.png`;
    const file = new File([blob], filename, { type: 'image/png' });

    const isLeaderboard = shareTargetData.type === 'leaderboard';
    const shareTitle = isLeaderboard ? `${shareTargetData.clubName} Leaderboard` : 'My run';
    const shareText = isLeaderboard
      ? `Leaderboard for ${shareTargetData.clubName} — via Runaway`
      : 'Logged on Runaway 🏃';

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: shareTitle, text: shareText });
      } catch (err) {
        // The user closing the share sheet rejects with AbortError — not a real
        // failure, so don't show an error for it.
        if (err.name !== 'AbortError') throw err;
      }
    } else {
      // No native file sharing (typically desktop): save the PNG so the user can
      // upload it to Instagram themselves.
      triggerDownloadBlob(blob, filename);
      alert("This browser can't open a share sheet, so the card was saved as an image. Upload it to Instagram from your gallery.");
    }
  } catch (err) {
    console.error('Share action failed:', err);
    alert('Couldn\'t share the card: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

async function triggerDownload() {
  const btn = $('#btn-share-download');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    const blob = await generateCardBlob();
    if (!blob) throw new Error('Could not render image.');

    const filename = `runaway_${shareTargetData.type}_${Date.now()}.png`;
    triggerDownloadBlob(blob, filename);
  } catch (err) {
    alert('Failed to download image: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function triggerDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

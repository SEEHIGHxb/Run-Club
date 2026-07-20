// ============================================================================
//  Runaway · Strava-style Stat and Leaderboard Sharing manager
//  Utilizes html2canvas to render high-resolution 1080p cards off-screen
//  and connects to the Web Share API and canvas download operations.
// ============================================================================

import { $, escapeHtml, fmtKm, fmtDuration, paceLabel, fmtDate, safeUrl } from './util.js';
import { state } from './state.js';

let html2canvasModule = null;

// Safe single-letter avatar fallback: escaped so a name starting with `<`/`&`
// can't corrupt the card markup, and never throws on an empty/whitespace name
// (a bare `name[0]` on '' is undefined → .toUpperCase() would crash the render).
function initial(name) {
  const s = (name || '').trim();
  return s ? escapeHtml(s[0].toUpperCase()) : '?';
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

  updateSharePreview();
  $('#share-modal').hidden = false;
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

  updateSharePreview();
  $('#share-modal').hidden = false;
}

// Generate the HTML template for the card
function buildCardHtml(renderRatio, renderTheme) {
  if (!shareTargetData) return '';

  const ratioClass = renderRatio === 'post' ? ' post-format' : '';
  const themeClass = ` share-theme-${renderTheme}`;
  const isLeaderboard = shareTargetData.type === 'leaderboard';

  let contentHtml = '';

  if (isLeaderboard) {
    const { clubName, range, ranked } = shareTargetData;
    const rangeLabel = range === 'week' ? 'This Week' : range === 'month' ? 'This Month' : 'All Time';
    
    // Only display top 5 to fit the layout comfortably
    const topRanked = ranked.slice(0, 5);
    const listItems = topRanked.map((row, index) => {
      // Sanitize the avatar URL the same way the rest of the app does (safeUrl),
      // then escape it for the attribute; fall back to a safe initial otherwise.
      const safeAvatar = safeUrl(row.avatar);
      const avatarHtml = safeAvatar
        ? `<img class="card-leaderboard-avatar" src="${escapeHtml(safeAvatar)}" crossorigin="anonymous">`
        : `<div class="card-leaderboard-avatar card-avatar-fallback" style="font-size:2.4rem;">${initial(row.name)}</div>`;

      return `
        <li class="card-leaderboard-row">
          <span class="card-leaderboard-rank">#${index + 1}</span>
          ${avatarHtml}
          <span class="card-leaderboard-name">${escapeHtml(row.name)}</span>
          <span class="card-leaderboard-km">${fmtKm(row.km)}</span>
        </li>
      `;
    }).join('');

    contentHtml = `
      <div class="card-header-brand">
        <div>
          <span class="card-title">${escapeHtml(clubName)}</span>
          <div style="font-size:1.5rem; opacity:0.8; margin-top:4px;">Club Leaderboard · ${rangeLabel}</div>
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

    const avatarHtml = safeAvatar
      ? `<img class="card-runner-avatar" src="${escapeHtml(safeAvatar)}" crossorigin="anonymous">`
      : `<div class="card-runner-avatar card-avatar-fallback" style="font-size:3rem;">${initial(runnerName)}</div>`;

    const notesHtml = run.notes ? `<div class="card-notes">"${escapeHtml(run.notes)}"</div>` : '';
    const paceRow = pace ? `
      <div class="card-stat-row">
        <span class="card-stat-label">Pace</span>
        <span class="card-stat-value">${pace}</span>
      </div>` : '';
    const durationRow = run.duration_min ? `
      <div class="card-stat-row">
        <span class="card-stat-label">Duration</span>
        <span class="card-stat-value">${fmtDuration(run.duration_min)}</span>
      </div>` : '';

    contentHtml = `
      <div class="card-header-brand">
        <div class="card-runner-profile">
          ${avatarHtml}
          <div>
            <div class="card-runner-name">${escapeHtml(runnerName)}</div>
            <div style="font-size:1.5rem; opacity:0.8;">logged a run</div>
          </div>
        </div>
        <img class="card-logo" src="./icons/runorlose.png" alt="Logo">
      </div>

      <div class="card-stats-container">
        <div class="card-stat-row">
          <span class="card-stat-label">Distance</span>
          <span class="card-stat-value" style="font-size: 4.5rem; font-weight:900;">${fmtKm(run.distance_km)}</span>
        </div>
        ${durationRow}
        ${paceRow}
        ${notesHtml}
      </div>
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
  
  // Align transform scales based on aspect ratio
  if (shareRatio === 'post') {
    container.style.height = '1080px';
  } else {
    container.style.height = '1920px';
  }
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

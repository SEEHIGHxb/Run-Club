// ============================================================================
//  Runaway · Draggable theme switch
//  Light/dark segmented control with a draggable, elastic handle. Persists the
//  choice in localStorage and stamps data-theme on <html>.
// ============================================================================

import { $ } from './util.js';

export function initThemeSwitch() {
  const seg = $('#theme-switch');
  if (!seg) return;
  const buttons = seg.querySelectorAll('.theme-seg-btn');
  const handle = seg.querySelector('.theme-seg-handle');
  if (buttons.length !== 2 || !handle) return;

  let theme = localStorage.getItem('theme') || 'light';

  function applyTheme(choice) {
    theme = choice === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    highlightTheme(theme);
    syncHandle();
  }

  function highlightTheme(choice) {
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeChoice === choice);
    });
  }

  function syncHandle() {
    const activeIndex = buttons[0].classList.contains('active') ? 0 : 1;
    const handleWidth = seg.offsetWidth / 2 - 2;
    seg.style.setProperty('--handle-offset', `${activeIndex * handleWidth}px`);
  }

  // Click handler for buttons
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    applyTheme(btn.dataset.themeChoice);
  });

  // Draggable Logic
  let isDragging = false;
  let currentOffset = 0;
  let handleWidth = seg.offsetWidth / 2 - 2;

  function onStart(e) {
    e.preventDefault();
    isDragging = true;
    handleWidth = seg.offsetWidth / 2 - 2;
    seg.classList.add('dragging');

    const rect = seg.getBoundingClientRect();
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clickX = clientX - rect.left;

    currentOffset = clickX - (handleWidth / 2);
    currentOffset = Math.max(0, Math.min(handleWidth, currentOffset));
    seg.style.setProperty('--handle-offset', `${currentOffset}px`);

    document.addEventListener('mousemove', onMove, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  }

  function onMove(e) {
    if (!isDragging) return;
    e.preventDefault();

    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    if (clientX === undefined) return;

    const rect = seg.getBoundingClientRect();
    const dragX = clientX - rect.left;
    const rawOffset = dragX - (handleWidth / 2);

    // Apply drag resistance (elastic bounds)
    if (rawOffset < 0) {
      currentOffset = rawOffset * 0.35;
    } else if (rawOffset > handleWidth) {
      currentOffset = handleWidth + (rawOffset - handleWidth) * 0.35;
    } else {
      currentOffset = rawOffset;
    }

    const maxStretch = 0.22;
    const centerOffset = rawOffset - (handleWidth / 2);
    const dragPercent = Math.min(Math.abs(centerOffset) / (handleWidth / 2), 1);
    const scaleX = 1 + (dragPercent * maxStretch);

    const origin = centerOffset >= 0 ? "left center" : "right center";
    seg.style.setProperty('--handle-origin', origin);
    seg.style.setProperty('--handle-scale-x', scaleX);
    seg.style.setProperty('--handle-offset', `${currentOffset}px`);
  }

  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    seg.classList.remove('dragging');
    seg.style.setProperty('--handle-scale-x', '1');

    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchend', onEnd);

    const threshold = handleWidth / 2;
    const targetIndex = currentOffset > threshold ? 1 : 0;
    const currentActiveIndex = buttons[0].classList.contains('active') ? 0 : 1;

    if (targetIndex !== currentActiveIndex) {
      applyTheme(buttons[targetIndex].dataset.themeChoice);
    } else {
      seg.style.setProperty('--handle-offset', `${currentActiveIndex * handleWidth}px`);
    }
  }

  seg.addEventListener('mousedown', onStart);
  seg.addEventListener('touchstart', onStart, { passive: false });

  // Initialize state
  applyTheme(theme);

  // Watch for window resize to resync handle width/offset
  window.addEventListener('resize', syncHandle);

  setTimeout(() => {
    seg.classList.add('seg-ready');
  }, 100);
}

// ============================================================================
//  Runaway · Avatar cropper (pan + zoom → small square WebP)
//  Lets the user reposition/zoom an oversized photo to fit the round avatar,
//  and exports a capped-size WebP so Supabase storage stays lean. The cropped
//  Blob is handed to the onCropped callback; profile save logic stays in
//  app.js.
// ============================================================================

import { $ } from './util.js';

const CROP_VIEW = 280;                    // on-screen crop viewport edge (px)
const CROP_OUTPUT = 400;                   // exported image edge (px)
const CROP_MAX_INPUT_BYTES = 15 * 1024 * 1024; // reject absurd source files early

const crop = {
  img: null, baseCover: 1, zoom: 1,
  offsetX: 0, offsetY: 0,
  dragging: false, lastX: 0, lastY: 0,
};

let onCroppedCallback = null;

// Wire up the cropper modal AND the avatar file input that feeds it.
// onCropped(blob) fires when the user saves a crop.
export function initAvatarCropper(onCropped) {
  onCroppedCallback = onCropped;
  const canvas = $('#crop-canvas');
  if (!canvas) return;

  // Picking a file opens the cropper rather than uploading the raw image.
  $('.avatar-edit-container').addEventListener('click', () => $('#f-avatar-file').click());
  $('#f-avatar-file').addEventListener('change', onAvatarFilePicked);

  $('#crop-zoom').addEventListener('input', onCropZoom);
  canvas.addEventListener('pointerdown', onCropDown);
  canvas.addEventListener('pointermove', onCropMove);
  canvas.addEventListener('pointerup', onCropUp);
  canvas.addEventListener('pointercancel', onCropUp);
  $('#btn-crop-save').addEventListener('click', saveCrop);
  $('#btn-crop-cancel').addEventListener('click', () => {
    $('#avatar-crop-modal').hidden = true;
  });
}

function onAvatarFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-picking the same file later
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('Please choose an image file.');
    return;
  }
  if (file.size > CROP_MAX_INPUT_BYTES) {
    alert('That image is too large. Please pick one under 15 MB.');
    return;
  }
  openCropper(file);
}

function openCropper(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    crop.img = img;
    // "Cover" scale so the image fully fills the square at zoom = 1.
    crop.baseCover = Math.max(CROP_VIEW / img.width, CROP_VIEW / img.height);
    crop.zoom = 1;
    $('#crop-zoom').value = '1';
    centerCrop();
    drawCrop();
    $('#avatar-crop-modal').hidden = false;
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert('Could not read that image. Try a different file.');
  };
  img.src = url;
}

function cropScale() { return crop.baseCover * crop.zoom; }
function cropDrawW() { return crop.img.width * cropScale(); }
function cropDrawH() { return crop.img.height * cropScale(); }

// Keep the image covering the viewport on all sides (no empty gaps).
function clampCrop() {
  const minX = CROP_VIEW - cropDrawW();
  const minY = CROP_VIEW - cropDrawH();
  crop.offsetX = Math.min(0, Math.max(minX, crop.offsetX));
  crop.offsetY = Math.min(0, Math.max(minY, crop.offsetY));
}

function centerCrop() {
  crop.offsetX = (CROP_VIEW - cropDrawW()) / 2;
  crop.offsetY = (CROP_VIEW - cropDrawH()) / 2;
}

function drawCrop() {
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CROP_VIEW, CROP_VIEW);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.img, crop.offsetX, crop.offsetY, cropDrawW(), cropDrawH());
}

function onCropZoom(e) {
  if (!crop.img) return;
  const prevScale = cropScale();
  const center = CROP_VIEW / 2;
  // Image-space point currently under the viewport centre — keep it fixed.
  const imgX = (center - crop.offsetX) / prevScale;
  const imgY = (center - crop.offsetY) / prevScale;
  crop.zoom = Number(e.target.value);
  const newScale = cropScale();
  crop.offsetX = center - imgX * newScale;
  crop.offsetY = center - imgY * newScale;
  clampCrop();
  drawCrop();
}

function onCropDown(e) {
  if (!crop.img) return;
  crop.dragging = true;
  crop.lastX = e.clientX;
  crop.lastY = e.clientY;
  if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
}

function onCropMove(e) {
  if (!crop.dragging) return;
  crop.offsetX += e.clientX - crop.lastX;
  crop.offsetY += e.clientY - crop.lastY;
  crop.lastX = e.clientX;
  crop.lastY = e.clientY;
  clampCrop();
  drawCrop();
}

function onCropUp() {
  crop.dragging = false;
}

function saveCrop() {
  if (!crop.img) return;
  const factor = CROP_OUTPUT / CROP_VIEW;
  const out = document.createElement('canvas');
  out.width = CROP_OUTPUT;
  out.height = CROP_OUTPUT;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    crop.img,
    crop.offsetX * factor, crop.offsetY * factor,
    cropDrawW() * factor, cropDrawH() * factor,
  );
  out.toBlob((blob) => {
    if (!blob) { alert('Could not process that image. Try another.'); return; }
    if (onCroppedCallback) onCroppedCallback(blob);
    $('#avatar-crop-modal').hidden = true;
  }, 'image/webp', 0.85);
}

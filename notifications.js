// ============================================================================
//  Runaway · Web Push Notifications manager
//  Manages permission requesting, registering/unregistering Web Push
//  subscriptions via Service Worker, and syncing to the Supabase database.
// ============================================================================

import { VAPID_PUBLIC_KEY } from './config.js';
import { supabase } from './db.js';
import { $ } from './util.js';

let isNotificationsSupported = false;

// Check support
if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
  isNotificationsSupported = true;
}

export function isSupported() {
  return isNotificationsSupported;
}

// Convert VAPID key to Uint8Array required by pushManager.subscribe
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function initNotifications() {
  const switchSeg = $('#notify-switch');
  if (!switchSeg) return;

  if (!isNotificationsSupported) {
    // Hide or disable the toggle if push is not supported
    switchSeg.closest('.field').style.opacity = '0.5';
    switchSeg.style.pointerEvents = 'none';
    switchSeg.setAttribute('title', 'Push notifications are not supported on this browser/device.');
    return;
  }

  const buttons = switchSeg.querySelectorAll('.theme-seg-btn');
  const handle = switchSeg.querySelector('.theme-seg-handle');
  if (buttons.length !== 2 || !handle) return;

  // Sync state initially
  await syncNotificationUiState();

  // Add click listener
  switchSeg.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-notify-choice]');
    if (!btn) return;
    const choice = btn.dataset.notifyChoice;

    if (choice === 'on') {
      const success = await subscribeFlow();
      if (success) {
        applyUiChoice('on');
      } else {
        applyUiChoice('off');
      }
    } else {
      await unsubscribeFlow();
      applyUiChoice('off');
    }
  });

  // Handle window resizing to keep the slider aligned
  window.addEventListener('resize', () => {
    const activeBtn = switchSeg.querySelector('.theme-seg-btn.active');
    if (activeBtn) {
      applyUiChoice(activeBtn.dataset.notifyChoice);
    }
  });

  // Ready transition class
  setTimeout(() => {
    switchSeg.classList.add('seg-ready');
  }, 100);
}

// UI Sync methods
async function syncNotificationUiState() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  const hasPermission = Notification.permission === 'granted';

  if (subscription && hasPermission) {
    applyUiChoice('on');
  } else {
    applyUiChoice('off');
  }
}

function applyUiChoice(choice) {
  const switchSeg = $('#notify-switch');
  if (!switchSeg) return;
  const buttons = switchSeg.querySelectorAll('.theme-seg-btn');
  
  buttons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.notifyChoice === choice);
  });

  const activeIndex = choice === 'on' ? 1 : 0;
  const handleWidth = switchSeg.offsetWidth / 2 - 2;
  switchSeg.style.setProperty('--handle-offset', `${activeIndex * handleWidth}px`);
}

// Subscribe Flow
async function subscribeFlow() {
  try {
    // 1. Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('Notification permission denied. Please allow notifications in your site settings.');
      return false;
    }

    // 2. Register subscription
    const registration = await navigator.serviceWorker.ready;
    const subscribeOptions = {
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    };

    const subscription = await registration.pushManager.subscribe(subscribeOptions);

    // 3. Save subscription to database
    const { data: { session } } = await supabase.auth.getSession();
    const myId = session?.user?.id;
    if (!myId) throw new Error('Not authenticated');

    const jsonSub = subscription.toJSON();
    const subRecord = {
      user_id: myId,
      endpoint: jsonSub.endpoint,
      p256dh: jsonSub.keys.p256dh,
      auth: jsonSub.keys.auth,
    };

    // Upsert subscription (unique on user_id + endpoint)
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(subRecord, { onConflict: 'user_id,endpoint' });

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('Failed to subscribe to push notifications:', err);
    alert('Subscription failed: ' + err.message);
    return false;
  }
}

// Unsubscribe Flow
async function unsubscribeFlow() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    // 1. Delete from database
    const endpoint = subscription.endpoint;
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);

    if (error) console.warn('Could not remove subscription from database:', error.message);

    // 2. Unsubscribe via pushManager
    await subscription.unsubscribe();
  } catch (err) {
    console.error('Failed to unsubscribe from push notifications:', err);
  }
}

/* Popup: a thin editor over chrome.storage.sync. The content script listens for
   storage changes, so every move here lands on the page immediately. */

const DEFAULTS = {
  enabled: true,
  brightness: 1,
  contrast: 1,
  mediaBrightness: 0.92,
  fixFixed: true
};

const SLIDERS = ['brightness', 'contrast', 'mediaBrightness'];

const el = (id) => document.getElementById(id);
const panel = el('panel');

let writeTimer = 0;
let pending = null;

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  render(settings);

  el('enabled').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    panel.dataset.off = enabled ? '' : '1';
    save({ enabled });
  });

  el('fixFixed').addEventListener('change', (e) => save({ fixFixed: e.target.checked }));

  for (const key of SLIDERS) {
    el(key).addEventListener('input', (e) => {
      const value = Number(e.target.value);
      el(`${key}-out`).textContent = percent(value);
      save({ [key]: value }, true);
    });
  }

  el('reset').addEventListener('click', async () => {
    await write(DEFAULTS);
    render(DEFAULTS);
  });
}

function render(settings) {
  el('enabled').checked = settings.enabled;
  el('fixFixed').checked = settings.fixFixed;
  panel.dataset.off = settings.enabled ? '' : '1';

  for (const key of SLIDERS) {
    el(key).value = settings[key];
    el(`${key}-out`).textContent = percent(settings[key]);
  }
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

/* Dragging a slider fires input on every pixel; coalesce those writes into one
   pending patch so a fast move between two sliders cannot drop either value. */
function save(patch, debounced = false) {
  if (!debounced) return void write(patch);
  pending = { ...(pending || {}), ...patch };
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const batch = pending;
    pending = null;
    write(batch);
  }, 80);
}

/* storage.sync allows on the order of 120 writes a minute. The debounce above makes that
   unlikely, but a throttled write used to reject with nobody listening, so the setting
   silently failed to stick. Retry once, then fall back to local storage — the content
   script already listens to both areas — and say so rather than failing quietly. */
async function write(patch, retried = false) {
  try {
    await chrome.storage.sync.set(patch);
  } catch (err) {
    if (!retried) {
      setTimeout(() => write(patch, true), 400);
      return;
    }
    try {
      await chrome.storage.local.set(patch);
      console.warn('[Night Mode for TCGplayer] sync storage unavailable, kept locally:', err);
    } catch (err2) {
      console.error('[Night Mode for TCGplayer] could not save settings:', err2);
    }
  }
}

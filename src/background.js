/* Night Mode for TCGplayer - service worker.
 *
 * Owns one job: make sure night.css is registered as a document_start content
 * script exactly when night mode is on, so pages paint dark on the very first
 * frame instead of flashing white. Toggling off unregisters it; the page-side
 * script handles already-loaded tabs by flipping the data-tcgnm gate.
 */

const SCRIPT_ID = 'tcgnm-night-css';
const MATCHES = ['*://*.tcgplayer.com/*'];
const CSS_FILE = 'src/night.css';

const DEFAULTS = {
  enabled: true,
  brightness: 1,
  contrast: 1,
  mediaBrightness: 0.92,
  fixFixed: true
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set({ ...DEFAULTS, ...current });
  await sync();
});

chrome.runtime.onStartup.addListener(sync);

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'sync' || area === 'local') && 'enabled' in changes) sync();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-night-mode') return;
  const { enabled } = await chrome.storage.sync.get({ enabled: DEFAULTS.enabled });
  await chrome.storage.sync.set({ enabled: !enabled });
});

/* A tab that was already open when night mode was switched on never received
   the registered stylesheet. The content script notices and asks for it. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'tcgnm:inject-css' || !sender.tab) return;
  chrome.scripting
    .insertCSS({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      files: [CSS_FILE]
    })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // async response
});

async function sync() {
  const { enabled } = await chrome.storage.sync.get({ enabled: DEFAULTS.enabled });

  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  } catch (_) {
    registered = [];
  }

  if (enabled) {
    const definition = {
      id: SCRIPT_ID,
      matches: MATCHES,
      css: [CSS_FILE],
      runAt: 'document_start',
      allFrames: true
    };
    try {
      if (registered.length) await chrome.scripting.updateContentScripts([definition]);
      else await chrome.scripting.registerContentScripts([definition]);
    } catch (err) {
      console.error('[Night Mode for TCGplayer] could not register stylesheet:', err);
    }
  } else if (registered.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    } catch (err) {
      console.error('[Night Mode for TCGplayer] could not unregister stylesheet:', err);
    }
  }

  await paintBadge(enabled);
}

async function paintBadge(enabled) {
  try {
    await chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
    await chrome.action.setBadgeBackgroundColor({ color: '#4b5563' });
    await chrome.action.setTitle({
      title: enabled ? 'Night Mode for TCGplayer - on' : 'Night Mode for TCGplayer - off'
    });
  } catch (_) {
    /* badge is cosmetic */
  }
}

/* The worker can be torn down and revived at any time; re-assert on wake. */
sync();

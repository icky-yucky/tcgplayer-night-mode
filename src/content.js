/* Night Mode for TCGplayer - page-side controller.
 *
 * The stylesheet itself is registered by the service worker so it lands before first paint
 * (no white flash). This script:
 *   1. flips :root[data-tcgnm] on/off, instantly, without a reload
 *   2. pushes the user's slider values in as CSS custom properties
 *   3. compensates for `position: fixed` elements, which a root-level filter re-anchors to
 *      the top of the document
 *
 * Top frame only. A sub-frame that filtered itself would be inverted twice — once by its own
 * :root filter and again by the parent's media rule, which un-inverts the iframe element to
 * keep its content true to colour. The parent's pass is the correct one and works regardless
 * of the frame's origin, so frames leave themselves alone.
 */

(() => {
  'use strict';

  if (window.top !== window.self) return;

  const DEFAULTS = {
    enabled: true,
    brightness: 1,
    contrast: 1,
    mediaBrightness: 0.92,
    fixFixed: true
  };

  let settings = { ...DEFAULTS };
  let fixedWatchActive = false;
  let scanTimer = 0;
  let sweepTimer = 0;
  let rafPending = false;
  let observer = null;
  const tagged = new Set();
  const pending = new Set();
  // class+style signature per element, so an element that has not changed is not restyled.
  const seen = new WeakMap();

  /* ---------- boot ------------------------------------------------------- */

  whenRoot(() => {
    load().then(apply);

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' && area !== 'local') return;
        let touched = false;
        for (const key of Object.keys(DEFAULTS)) {
          if (key in changes) {
            settings[key] = changes[key].newValue ?? DEFAULTS[key];
            touched = true;
          }
        }
        if (touched) apply();
      });
    } catch (_) {
      /* extension reloaded out from under the page */
    }
  });

  function whenRoot(fn) {
    if (document.documentElement) return void fn();
    const mo = new MutationObserver(() => {
      if (document.documentElement) {
        mo.disconnect();
        fn();
      }
    });
    mo.observe(document, { childList: true, subtree: true });
  }

  /* Local is read after sync and wins, because the popup falls back to local storage when a
     sync write is throttled. Without this, a setting saved during a throttle would apply
     immediately (the change listener covers both areas) and then vanish on the next load. */
  async function load() {
    try {
      const [synced, local] = await Promise.all([
        chrome.storage.sync.get(DEFAULTS).catch(() => ({})),
        chrome.storage.local.get({}).catch(() => ({}))
      ]);
      const localKnown = {};
      for (const key of Object.keys(DEFAULTS)) {
        if (key in local) localKnown[key] = local[key];
      }
      settings = { ...DEFAULTS, ...synced, ...localKnown };
    } catch (_) {
      settings = { ...DEFAULTS };
    }
    return settings;
  }

  /* An extension update or disable leaves this script running in a page it can no longer
     talk to. Detect that and take our attributes back off rather than leaving them behind. */
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /* ---------- apply ------------------------------------------------------ */

  function apply() {
    const root = document.documentElement;
    if (!root) return;

    if (!settings.enabled) {
      root.setAttribute('data-tcgnm', 'off');
      stopFixedWatch();
      return;
    }

    root.style.setProperty('--tcgnm-brightness', String(settings.brightness));
    root.style.setProperty('--tcgnm-contrast', String(settings.contrast));
    root.style.setProperty('--tcgnm-media-brightness', String(settings.mediaBrightness));
    root.setAttribute('data-tcgnm', 'on');

    ensureStylesheet();

    if (settings.fixFixed) startFixedWatch();
    else stopFixedWatch();
  }

  /* The service worker normally has the CSS registered before this frame runs, but on a tab
     that was already open when night mode got switched on there is nothing injected yet.
     Detect that via the sentinel custom property. */
  function ensureStylesheet() {
    const loaded = getComputedStyle(document.documentElement)
      .getPropertyValue('--tcgnm-loaded')
      .trim();
    if (loaded === '1') return;
    try {
      chrome.runtime.sendMessage({ type: 'tcgnm:inject-css' });
    } catch (_) {
      /* nothing we can do from here */
    }
  }

  /* ---------- position: fixed compensation -------------------------------- */

  /* Names that suggest an element floats. `fixed` and `chat` are matched on a word boundary
     rather than as bare substrings, which previously pulled in `prefixed`, `chatter` and
     anything else that merely contained them. */
  const FIXED_CANDIDATE_SELECTOR = [
    'dialog',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[class*="modal"]',
    '[class*="overlay"]',
    '[class*="popover"]',
    '[class*="dropdown"]',
    '[class*="drawer"]',
    '[class*="toast"]',
    '[class*="sticky"]',
    '[class*="tooltip"]',
    '[class*="message-manager"]',
    '[class^="fixed"]',
    '[class*=" fixed"]',
    '[class*="-fixed"]',
    '[class*="fixed-"]',
    '[class^="chat"]',
    '[class*=" chat"]',
    '[class*="-chat"]',
    '[class*="chat-"]'
  ].join(',');

  const MAX_PER_BATCH = 400;
  const SWEEP_MS = 5000;

  function startFixedWatch() {
    if (fixedWatchActive) return;
    fixedWatchActive = true;

    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', scheduleScan, { passive: true });

    observer = new MutationObserver(collect);
    const attach = () => {
      if (!document.body) return false;
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      seedFromDocument();
      return true;
    };
    if (!attach()) document.addEventListener('DOMContentLoaded', attach, { once: true });

    // Cascade changes (a parent class that restyles descendants through a stylesheet) do not
    // always show up as a mutation on the element that moves, so a slow full sweep backs the
    // mutation path up. At 5s this costs a fraction of the old scan-after-every-mutation.
    sweepTimer = setInterval(() => {
      if (!contextAlive()) return void stopFixedWatch();
      seedFromDocument();
      scheduleScan();
    }, SWEEP_MS);

    onScroll();
    scheduleScan();
  }

  function stopFixedWatch() {
    if (!fixedWatchActive) return;
    fixedWatchActive = false;

    removeEventListener('scroll', onScroll);
    removeEventListener('resize', scheduleScan);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(scanTimer);
    clearInterval(sweepTimer);
    pending.clear();

    for (const el of tagged) el.removeAttribute('data-tcgnm-fixed');
    tagged.clear();

    const root = document.documentElement;
    if (root) {
      root.style.removeProperty('--tcgnm-scroll-x');
      root.style.removeProperty('--tcgnm-scroll-y');
    }
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const root = document.documentElement;
      if (!root) return;
      root.style.setProperty('--tcgnm-scroll-x', `${Math.round(scrollX)}px`);
      root.style.setProperty('--tcgnm-scroll-y', `${Math.round(scrollY)}px`);
    });
  }

  /* Mutation records name exactly what changed, so only those elements need looking at —
     rather than re-walking the document and re-styling several hundred elements every time
     a search page streams in another card. */
  function collect(records) {
    if (!fixedWatchActive) return;
    for (const rec of records) {
      if (rec.type === 'attributes') {
        addCandidate(rec.target);
        // A class change on a container can move its descendants too.
        addMatchingDescendants(rec.target);
      } else {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          addCandidate(node);
          addMatchingDescendants(node);
        }
      }
      if (pending.size >= MAX_PER_BATCH) break;
    }
    if (pending.size) scheduleScan();
  }

  function addCandidate(el) {
    if (el && el.nodeType === 1 && pending.size < MAX_PER_BATCH) pending.add(el);
  }

  function addMatchingDescendants(el) {
    if (!el || el.nodeType !== 1 || typeof el.querySelectorAll !== 'function') return;
    let n = 0;
    for (const d of el.querySelectorAll(FIXED_CANDIDATE_SELECTOR)) {
      addCandidate(d);
      if (++n >= 64 || pending.size >= MAX_PER_BATCH) break;
    }
  }

  /* One bounded pass over what already exists, for the elements that were on the page before
     the observer attached. */
  function seedFromDocument() {
    if (!document.body) return;
    let level = [document.body];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const next = [];
      for (const el of level) {
        for (const child of el.children) {
          addCandidate(child);
          next.push(child);
        }
      }
      level = next.slice(0, 300);
    }
    addMatchingDescendants(document.body);
  }

  function scheduleScan() {
    if (!fixedWatchActive) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPending, 250);
  }

  function scanPending() {
    if (!fixedWatchActive) return;
    if (!contextAlive()) return void stopFixedWatch();

    for (const el of pending) {
      if (!el.isConnected) continue;
      // Skip anything whose class and style are unchanged since the last look.
      const sig = `${el.getAttribute('class') || ''}|${el.getAttribute('style') || ''}`;
      if (seen.get(el) === sig && tagged.has(el) === (el.getAttribute('data-tcgnm-fixed') === '1')) {
        continue;
      }
      seen.set(el, sig);

      if (getComputedStyle(el).position === 'fixed') {
        if (!tagged.has(el)) {
          el.setAttribute('data-tcgnm-fixed', '1');
          tagged.add(el);
        }
      } else if (tagged.has(el)) {
        el.removeAttribute('data-tcgnm-fixed');
        tagged.delete(el);
      }
    }
    pending.clear();

    // Detached nodes need no style lookup, just dropping.
    for (const el of tagged) {
      if (!el.isConnected) tagged.delete(el);
    }
  }
})();

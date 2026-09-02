/* Night Mode for TCGplayer - page-side controller.
 *
 * The stylesheet itself is registered by the service worker so it lands before
 * first paint (no white flash). This script:
 *   1. flips :root[data-tcgnm] on/off, instantly, without a reload
 *   2. pushes the user's slider values in as CSS custom properties
 *   3. compensates for `position: fixed` elements, which a root-level filter
 *      re-anchors to the top of the document
 */

(() => {
  'use strict';

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
  let rafPending = false;
  let observer = null;
  const tagged = new Set();

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

  async function load() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...stored };
    } catch (_) {
      settings = { ...DEFAULTS };
    }
    return settings;
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

  /* The service worker normally has the CSS registered before this frame runs,
     but on a tab that was already open when night mode got switched on there is
     nothing injected yet. Detect that via the sentinel custom property. */
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
    '[class*="fixed"]',
    '[class*="tooltip"]',
    '[class*="banner"]',
    '[class*="message-manager"]',
    '[class*="chat"]'
  ].join(',');

  const MAX_CANDIDATES = 900;

  function startFixedWatch() {
    if (fixedWatchActive) return;
    fixedWatchActive = true;

    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', scheduleScan, { passive: true });

    observer = new MutationObserver(scheduleScan);
    const attach = () => {
      if (!document.body) return false;
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
      return true;
    };
    if (!attach()) document.addEventListener('DOMContentLoaded', attach, { once: true });

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

  function scheduleScan() {
    if (!fixedWatchActive) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForFixed, 250);
  }

  /* Walking every node on a TCGplayer search page would be wasteful, so the
     candidate set is the top few levels of the tree plus anything whose class
     name suggests it floats. That covers the site's dropdowns, popovers,
     nav overlays and the bottom-right message manager. */
  function scanForFixed() {
    if (!fixedWatchActive || !document.body) return;

    const candidates = new Set();

    let level = [document.body];
    for (let depth = 0; depth < 3 && level.length; depth++) {
      const next = [];
      for (const el of level) {
        for (const child of el.children) {
          candidates.add(child);
          next.push(child);
        }
      }
      level = next.slice(0, 300);
    }

    let n = 0;
    for (const el of document.querySelectorAll(FIXED_CANDIDATE_SELECTOR)) {
      candidates.add(el);
      if (++n >= MAX_CANDIDATES) break;
    }

    const stillFixed = new Set();
    for (const el of candidates) {
      if (getComputedStyle(el).position !== 'fixed') continue;
      stillFixed.add(el);
      if (!tagged.has(el)) {
        el.setAttribute('data-tcgnm-fixed', '1');
        tagged.add(el);
      }
    }

    for (const el of tagged) {
      if (stillFixed.has(el) && el.isConnected) continue;
      el.removeAttribute('data-tcgnm-fixed');
      tagged.delete(el);
    }
  }
})();

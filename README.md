# TCGplayer Night Mode

A dark theme for [tcgplayer.com](https://www.tcgplayer.com) that keeps card
images, product photos and set icons at their true colors.

## Install (Chrome, Edge, Brave, Opera)

1. Open `chrome://extensions` (`edge://extensions` on Edge).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `tcgplayer-night-mode` folder.
4. Visit tcgplayer.com. It's on by default.

Click the moon icon in the toolbar for the toggle and sliders, or press
**Alt + Shift + N** to flip it on and off. The badge reads `off` when the
theme is disabled.

## Controls

| Control | What it does |
| --- | --- |
| Master toggle | Turns the theme on/off everywhere, live, no reload |
| Brightness | Overall page brightness after inversion |
| Contrast | Useful if greys look muddy on your monitor |
| Image brightness | Dims card art so it doesn't glare against the dark UI |
| Keep pop-ups anchored | Fixes menus and dialogs that a page-wide filter would otherwise re-anchor to the top of the document (see below) |

Settings are stored in `chrome.storage.sync`, so they follow your browser
profile.

## How it works

The theme inverts the whole page and then inverts media elements back, which is
why card art stays true to color instead of coming out as a negative. That
approach adapts on its own when TCGplayer ships layout changes, unlike a
stylesheet that hardcodes their class names.

Two details are worth knowing:

- **No white flash.** The stylesheet is registered by the service worker as a
  `document_start` content script, so it applies before first paint. Turning
  night mode off unregisters it entirely, so a disabled extension costs a page
  nothing.
- **`position: fixed` compensation.** A CSS filter on `:root` makes it the
  containing block for fixed descendants, so dropdowns and dialogs would anchor
  to the top of the *document* rather than the viewport. `content.js` finds
  those elements and feeds the scroll offset back into the stylesheet via the
  `translate` property (chosen over `transform` so site animations still work).
  That's the "Keep pop-ups anchored" checkbox; turn it off if you ever suspect
  it of misbehaving.

## Layout

```
manifest.json        MV3 manifest
src/night.css        the theme
src/content.js       on/off gate, slider values, fixed-element compensation
src/background.js    registers/unregisters the stylesheet, keyboard shortcut, badge
src/popup.html/.css/.js   toolbar popup
icons/               crescent moon, 16/32/48/128
```

## Tweaking it

Everything visual lives in `src/night.css`.

- **A specific element shouldn't be touched?** Give it `class="tcgnm-keep"`, or
  add its selector to the media block near the top.
- **Something already dark comes out too bright?** TCGplayer's footer already
  ships dark, so inverting it would produce a white slab; the bottom of the file
  repaints it light-on-dark so the inversion lands it back on dark. Add any
  other already-dark block the site introduces to that same rule.

The homepage heroes are deliberately left alone: their art sits under a dark
scrim, and once the art is restored to true color the inverted scrim gives dark
text on a light backdrop, which reads fine on its own.

After editing, hit the reload arrow on the extension card and refresh the page.

## Firefox

The manifest targets Chromium. Firefox needs two changes: swap
`"background": { "service_worker": ... }` for
`"background": { "scripts": ["src/background.js"] }`, and add a
`browser_specific_settings.gecko.id`.

## Caveats

- Inverting a page flips *everything*, so an occasional element that was already
  dark will come out light until a rule is added for it.
- Logos with dark artwork on a transparent background are inverted back to their
  true colors, which can leave them low-contrast on the dark page.

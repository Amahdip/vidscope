---
name: capturing-readme-media
description: Regenerates Vidscope's logo lock-ups, social preview and the README demo GIFs with headless Chrome and FFmpeg (scripts/capture/). Use after a visible change to the viewer, when a README image is out of date, or when the logo or its colours change.
---

# Capturing README media

Everything is scripted, so the images always match the code.

```bash
node scripts/capture/brand.mjs    # docs/brand: logo-dark.png, logo-light.png, social-preview.png
node scripts/capture/demos.mjs    # docs/images/*.gif, the README demos
```

## Requirements

- Google Chrome or Chromium (found automatically, or set `CHROME` to its executable). The
  scripts drive it headless through `scripts/capture/cdp.mjs`; nothing is installed.
- FFmpeg, to assemble frames into GIFs.
- `npm run samples` for the test files. The demos with real pictures use Big Buck Bunny
  (Blender Foundation, CC BY 3.0); `demos.mjs` says where it looks for it and skips those
  demos when it is missing. Keep the credit line under the images in the README.

## Keeping them good

- The mark is `docs/brand/mark.svg`; the same shapes are inline in `web/ui/dom.js`
  (`brandMark`) and the favicon in `web/index.html`. Change all three together.
- Each GIF shows one thing a person can do, in under 15 seconds, at about 960 px wide. Keep
  each under 4 MB: shorter holds and fewer colours before a lower frame rate.
- Headless screenshots show no pointer; the demo script draws one so a viewer can follow
  the clicks.
- Look at every regenerated image before committing it: a changed layout can leave a demo
  clicking on the wrong thing.

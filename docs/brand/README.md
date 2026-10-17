# Selfhold identity

Production reconstruction of the selected round-two **A** concept: the S with a negative-space key, circular bow and single tooth. The source concept was visually inspected before reconstruction; these are clean paths, not a cropped/generated raster. B and C are not used.

- Master: `public/assets/selfhold-mark.svg`, 320-unit viewBox, no fonts, scripts or external references. Its ink follows the host light/dark preference.
- Toolbar/store icons: `public/assets/selfhold-icon-{16,32,48,128}.png`. Reversed white mark on a dark rounded tile; neutral outline separates it from dark toolbar surfaces.
- At 16 and 32px, the key opening and central dot are enlarged optically. 48 and 128px preserve master geometry.
- Tile vector: `docs/brand/selfhold-icon.svg`.
- Production/light-dark size preview: `docs/brand/selfhold-production-preview.png`.
- Store promotional art: `docs/store-assets/selfhold-promo-440x280.png`. This is brand artwork, not a screenshot.

Run `npm ci` and `npm run icons` on Node 24 to regenerate the master PNG and four icon exports with pinned development-only `@resvg/resvg-js` 2.6.2. The renderer is not bundled into the extension. Do not edit PNGs independently of the vector/export script.

Palette: ink/tile #101112, reversed mark #ffffff, outline #85878a. Light/dark previews were visually inspected at native 16/32/48px and reduced 128px. White-to-tile contrast exceeds 18:1; the outline gives separation on #202124. These static checks do not claim actual Chrome toolbar acceptance. Review browser rendering and regenerate listing screenshots with the final candidate before store submission.

Product descriptor: **Open-source, self-custodial wallet for Lattice.** Tagline: **Your keys. Your control.** Existing Lattice service URLs, support contact and protocol identifiers remain unchanged.

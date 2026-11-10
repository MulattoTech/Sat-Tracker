export type ManifestIcon = {
  src: string;
  sizes: string;
  type: 'image/png';
  purpose: 'any' | 'maskable';
};

/**
 * Icons advertised to PWA installers (static `/manifest.json` and the per-family
 * `/api/manifest/[slug]` route both serve this list).
 *
 * These are the square, full-bleed sat-tracker-*.png files, not the round
 * sprout-*.png set used for the favicon and in-app logos: home-screen launchers
 * draw their own mask, and a round source leaves transparent corners that iOS
 * composites onto black and Android crops unpredictably.
 */
export const PWA_ICONS: readonly ManifestIcon[] = [
  { src: '/sat-tracker-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/sat-tracker-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/sat-tracker-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  { src: '/sat-tracker-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
];

/** The Apple touch icon — same square artwork, since iOS applies its own rounding. */
export const APPLE_TOUCH_ICON = '/sat-tracker-192.png';

export function buildManifestIcons(): ManifestIcon[] {
  return PWA_ICONS.map((icon) => ({ ...icon }));
}

/**
 * Public-dir assets are copied next to `index.html`, so they must be referenced
 * relative to the renderer document. A leading slash only works while the
 * renderer is served from an origin that owns the path: it resolves to the
 * `prime-work://app/` protocol when packaged and to the vite dev server root in
 * development, but points at the filesystem root when the renderer is loaded
 * from `file://` (an unpackaged `electron .` run, `npm run preview`, and the
 * hermetic e2e), which silently blanks the image.
 */
export const GOOEYPI_MASCOT_SRC = 'gooeypi-mascot.png'

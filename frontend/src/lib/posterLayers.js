/** Pure helpers and constants behind the Poster constructor
 * (`components/workflow/PosterConstructor.jsx`): layer/effect factories,
 * normalization of a stored `Poster.layers` blob back into editor state, and
 * the center-snap / zoom-clamp math. No React, no Konva nodes - the drawing
 * itself lives in `PosterCanvasLayers.jsx`.
 */

/** Text-layer font choices for OverlayText - every entry other than Lato is
 * verified (via the raw Google Fonts css2 response, not just the specimen
 * page) to ship a cyrillic unicode-range block, since poster text is
 * typically Russian. Lato is kept only for latin content - Google's Lato
 * has no cyrillic glyphs at all, so cyrillic text in it silently falls back
 * to the browser's default sans-serif. See frontend/index.html's font
 * <link> for the matching Google Fonts request. */
export const FONT_OPTIONS = [
  { value: "'Forum', serif", label: 'Forum' },
  { value: "'Montserrat', sans-serif", label: 'Montserrat' },
  { value: "'PT Sans', sans-serif", label: 'PT Sans' },
  { value: "'Lato', sans-serif", label: 'Lato' },
  { value: "'Oswald', sans-serif", label: 'Oswald' },
  { value: "'Roboto Condensed', sans-serif", label: 'Roboto Condensed' },
  { value: "'Rubik', sans-serif", label: 'Rubik' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
];

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 6;
export const ZOOM_STEP = 1.25;

/** Screen-px distance (independent of zoom - divided by effectiveScale at
 * call time) within which a dragged object's center snaps to the poster's
 * own center. */
export const CENTER_SNAP_PX = 6;

export function genId() {
  return `l_${Math.random().toString(36).slice(2, 10)}`;
}

/** Fresh (non-shared) default effects for a newly placed layer - a glow
 * (Konva shadow on the image's own alpha shape) plus the layer's own
 * opacity, both left at "off"/100% until the user opts in via
 * EffectsPanel. */
export function makeDefaultEffects() {
  return {
    glow: { enabled: false, color: '#000000', blur: 12, distance: 6, opacity: 0.8 },
    // "Клон" - a second copy of the same layer rendered behind the real one,
    // offset by (offsetX, offsetY) - a cheap fake-3D/depth look (same trick
    // as a CSS double text-shadow). It renders with the same glow as the
    // real layer (so both copies get the halo, per the ask), plus its own
    // opacity and an optional blur that only ever applies to this back copy.
    clone: { enabled: false, offsetX: 14, offsetY: 14, opacity: 0.55, blur: 0 },
    opacity: 1,
  };
}

/** A single Konva shadow pass caps its visible strength at `shadowOpacity`
 * ~1 (the shadow color's alpha is clamped to [0,1] by the canvas itself, so
 * anything above that had no effect - the old 0-500% slider's 100-500%
 * range was dead). To let the intensity slider (now 0-100%, stored as
 * `glow.opacity` 0-5 - same numeric field as before, only the UI mapping
 * changed) go up to a genuine 5x boost, values above the single-pass max
 * (glow.opacity > 1) are rendered as several identical stacked shadow
 * passes instead of one - each pass's shadow alpha-composites over the
 * previous, so the halo actually gets denser/stronger past the old
 * ceiling. Below that ceiling (glow.opacity <= 1) this returns exactly one
 * pass at the configured opacity, i.e. pixel-identical to the old
 * single-shadow render. Note: every pass also redraws the layer's own
 * fill, so this intentionally keeps each pass at the layer's configured
 * opacity rather than decoupling fill from shadow (which would need an
 * offscreen-cache render) - with a non-default (reduced) layer opacity, a
 * maxed-out glow will read a little more solid/opaque than the opacity
 * slider alone implies. Accepted trade-off for a simple, low-risk render
 * path; the common case (layer opacity at/near 100%) is unaffected. */
export function glowPasses(glow) {
  if (!glow.enabled) return { count: 1, perPassOpacity: 0 };
  const count = Math.max(1, Math.ceil(glow.opacity));
  return { count, perPassOpacity: glow.opacity / count };
}

export function migrateEffects(effects) {
  const base = makeDefaultEffects();
  if (!effects) return base;
  return {
    glow: { ...base.glow, ...(effects.glow || {}) },
    clone: { ...base.clone, ...(effects.clone || {}) },
    opacity: effects.opacity ?? 1,
  };
}

export function makeLayer(overrides) {
  return {
    id: genId(), x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
    crop: null, effects: makeDefaultEffects(), ...overrides,
  };
}

/** Normalizes a saved poster's `title_card`/`logo` layer entry into the
 * array-of-layers shape this component now uses (multiple independent,
 * duplicatable/croppable copies of the same source image) - older saved
 * posters stored a single transform object instead of an array, so that
 * shape is wrapped rather than lost. */
export function normalizeLayers(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((l, i) => ({
    id: l.id || `legacy_${i}`,
    x: l.x, y: l.y, scaleX: l.scaleX, scaleY: l.scaleY, rotation: l.rotation,
    crop: l.crop || null,
    effects: migrateEffects(l.effects),
  }));
}

/** Normalizes a saved poster's `text` layer entries (see `layers.text` in
 * the poster schema) back into full layer objects, backfilling any field
 * missing from an older/partial save with a sane default - mirrors
 * `normalizeLayers`'s role for the image layers. */
export function normalizeTextLayers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((l) => ({
    id: l.id || genId(),
    x: l.x ?? 0, y: l.y ?? 0, scaleX: l.scaleX ?? 1, scaleY: l.scaleY ?? 1, rotation: l.rotation ?? 0,
    kind: 'text', textType: l.textType === 'badge' ? 'badge' : 'halo',
    text: l.text || '', fontFamily: l.fontFamily || FONT_OPTIONS[0].value,
    fontSize: l.fontSize || 48, color: l.color || '#ffffff', bgColor: l.bgColor || '#000000',
    align: ['left', 'center', 'right'].includes(l.align) ? l.align : 'left',
    effects: migrateEffects(l.effects),
  }));
}

/** Splits the Title Card stage's free-text `text_block` (two quoted lines,
 * e.g. `"Title"\n"Author"` - see useTitleCardStage.js / dict.js's
 * titleCard_defaultTextBlock) into the title/author strings used as the
 * default content for a newly placed halo/badge text layer. */
export function parseTextBlock(textBlock) {
  if (!textBlock) return { title: '', author: '' };
  const lines = textBlock.split('\n').map((l) => l.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return { title: lines[0] || '', author: lines[1] || '' };
}

/** The font size a freshly placed text layer of this type gets, scaled off
 * the background width - also used as the "reset to default" target for the
 * font-size slider in TextLayerPanel, since there's no single global default
 * (badge and halo text are sized very differently, and both scale with the
 * poster). */
export function defaultTextFontSize(textType, bgWidth) {
  return Math.round(bgWidth * (textType === 'badge' ? 0.026 : 0.075));
}

/** Builds a freshly placed text layer of the given type - `badge` (a black
 * pill, white Forum text, defaults to the author line) or `halo` (large
 * Montserrat text with a soft drop-shadow "halo", defaults to the title
 * line). `bg` is the background image's natural size; `defaults` is
 * `parseTextBlock`'s result, with `fallback` used when text_block is empty. */
export function makeTextLayer(textType, bg, defaults, fallback) {
  const isBadge = textType === 'badge';
  const fontSize = defaultTextFontSize(textType, bg.width);
  return makeLayer({
    kind: 'text', textType,
    text: (isBadge ? defaults.author : defaults.title) || (isBadge ? fallback.author : fallback.title),
    fontFamily: isBadge ? FONT_OPTIONS[0].value : "'Montserrat', sans-serif",
    fontSize, color: '#ffffff', bgColor: '#000000', align: 'left',
    x: bg.width * (isBadge ? 0.3 : 0.15),
    y: bg.height * (isBadge ? 0.82 : 0.08),
    effects: isBadge
      ? makeDefaultEffects()
      : { ...makeDefaultEffects(), glow: { enabled: true, color: '#1a1a1a', blur: 10, distance: 8, opacity: 0.65 } },
  });
}

/** Shared drag-time center-snap for every draggable overlay Group (image,
 * glass, text) - called from `onDragMove`. Compares the node's own
 * axis-aligned bounding-box center (in the shared bg-natural-pixel content
 * space) against the poster's center and, within `CENTER_SNAP_PX` screen
 * px (converted to that local space via `effectiveScale`), snaps the node
 * onto it directly - a cheap Konva-node mutation, not a React state update,
 * so it doesn't spam re-renders on every drag frame. Returns which guide
 * line(s) should be shown for this frame. */
export function snapGroupToCenter(node, bgWidth, bgHeight, effectiveScale) {
  const rect = node.getClientRect({ relativeTo: node.getParent() });
  const threshold = CENTER_SNAP_PX / effectiveScale;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = bgWidth / 2 - cx;
  const dy = bgHeight / 2 - cy;
  const snapV = Math.abs(dx) <= threshold;
  const snapH = Math.abs(dy) <= threshold;
  if (snapV) node.x(node.x() + dx);
  if (snapH) node.y(node.y() + dy);
  return { v: snapV, h: snapH };
}

export function makeDefaultGlass(bgW, bgH) {
  const w = bgW * 0.4;
  const h = bgH * 0.22;
  return {
    x: (bgW - w) / 2, y: (bgH - h) / 2,
    width: w, height: h, scaleX: 1, scaleY: 1, rotation: 0,
    cornerRadius: Math.min(w, h) * 0.14,
    opacity: 0.28, thickness: 45,
  };
}

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

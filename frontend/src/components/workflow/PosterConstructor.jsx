import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenter, AlignLeft, AlignRight, ChevronDown, ChevronUp, Copy, Crop, Maximize2, Minimize2, Minus, Plus,
  Redo2, RotateCcw, Save, Square, Trash2, Type, Undo2, X,
} from 'lucide-react';
import Konva from 'konva';
import { Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';

/** Text-layer font choices for OverlayText - every entry other than Lato is
 * verified (via the raw Google Fonts css2 response, not just the specimen
 * page) to ship a cyrillic unicode-range block, since poster text is
 * typically Russian. Lato is kept only for latin content - Google's Lato
 * has no cyrillic glyphs at all, so cyrillic text in it silently falls back
 * to the browser's default sans-serif. See frontend/index.html's font
 * <link> for the matching Google Fonts request. */
const FONT_OPTIONS = [
  { value: "'Forum', serif", label: 'Forum' },
  { value: "'Montserrat', sans-serif", label: 'Montserrat' },
  { value: "'PT Sans', sans-serif", label: 'PT Sans' },
  { value: "'Lato', sans-serif", label: 'Lato' },
  { value: "'Oswald', sans-serif", label: 'Oswald' },
  { value: "'Roboto Condensed', sans-serif", label: 'Roboto Condensed' },
  { value: "'Rubik', sans-serif", label: 'Rubik' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
];

const MAX_DISPLAY_W = 760;
const MAX_DISPLAY_H = 520;
// Fixed (non-growing) side panel width, in both modes, so expanding to
// fullscreen grows only the picture area, not the tools column. Wide enough
// for 4 thumbnails per row without wrapping.
const SIDE_PANEL_WIDTH = 300;
// Reserve (viewport px) subtracted from the fullscreen picture budget for
// the panel + gaps + the (edge-to-edge, fullscreen-only) modal-card's own
// small horizontal padding - see the fullscreen branch of modal-card's
// inline style below.
const SIDE_PANEL_RESERVE = 360;
// In fullscreen the header bar is removed entirely (see the fullscreen
// branch below) so the picture can span the full viewport height - only a
// thin bottom padding is reserved, no room for a title bar.
const FULLSCREEN_V_RESERVE = 24;

/** Extra canvas room (screen px) kept around the poster's visible bounds so
 * overlay objects (e.g. the glass panel below) can be dragged past the
 * poster edge and still be seen while editing - purely an editor
 * convenience. Cropped back out at export time (see handleSave), so the
 * saved poster is always exactly `canvasSize`. */
const OVERFLOW_MARGIN = 40;
const OVERFLOW_MARGIN_FULLSCREEN = 100;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.25;

/** Undo/redo history depth (oldest snapshots drop off past this). */
const MAX_HISTORY = 50;

/** Screen-px distance (independent of zoom - divided by effectiveScale at
 * call time) within which a dragged object's center snaps to the poster's
 * own center. */
const CENTER_SNAP_PX = 6;

function genId() {
  return `l_${Math.random().toString(36).slice(2, 10)}`;
}

/** Fresh (non-shared) default effects for a newly placed layer - a glow
 * (Konva shadow on the image's own alpha shape) plus the layer's own
 * opacity, both left at "off"/100% until the user opts in via
 * EffectsPanel. */
function makeDefaultEffects() {
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
function glowPasses(glow) {
  if (!glow.enabled) return { count: 1, perPassOpacity: 0 };
  const count = Math.max(1, Math.ceil(glow.opacity));
  return { count, perPassOpacity: glow.opacity / count };
}

/** Blurring the "clone" back-copy (see `makeDefaultEffects`'s `clone`) needs
 * Konva's cache+filter pipeline - a canvas shadow/image can't be blurred
 * directly, only a rasterized node can. Re-caches the clone Group whenever
 * blur is on and something that affects its look changes; clears the cache
 * when blur is dialed back to 0 so the clone goes back to rendering live
 * like every other node (cheaper, and always pixel-crisp). A fixed
 * `pixelRatio` is generous enough for a blurred (inherently soft) effect
 * without tracking the stage's current zoom/export scale. */
function useCloneBlur(ref, clone, deps) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (clone?.enabled && clone.blur > 0) {
      node.cache({ pixelRatio: 3 });
      node.filters([Konva.Filters.Blur]);
      node.blurRadius(clone.blur);
    } else if (node.isCached()) {
      node.clearCache();
    }
    node.getLayer()?.batchDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clone?.enabled, clone?.blur, clone?.offsetX, clone?.offsetY, ...deps]);
}

function migrateEffects(effects) {
  const base = makeDefaultEffects();
  if (!effects) return base;
  return {
    glow: { ...base.glow, ...(effects.glow || {}) },
    clone: { ...base.clone, ...(effects.clone || {}) },
    opacity: effects.opacity ?? 1,
  };
}

function makeLayer(overrides) {
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
function normalizeLayers(raw) {
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
function normalizeTextLayers(raw) {
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
function parseTextBlock(textBlock) {
  if (!textBlock) return { title: '', author: '' };
  const lines = textBlock.split('\n').map((l) => l.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  return { title: lines[0] || '', author: lines[1] || '' };
}

/** Builds a freshly placed text layer of the given type - `badge` (a black
 * pill, white Forum text, defaults to the author line) or `halo` (large
 * Montserrat text with a soft drop-shadow "halo", defaults to the title
 * line). `bg` is the background image's natural size; `defaults` is
 * `parseTextBlock`'s result, with `fallback` used when text_block is empty. */
function makeTextLayer(textType, bg, defaults, fallback) {
  const isBadge = textType === 'badge';
  const fontSize = Math.round(bg.width * (isBadge ? 0.026 : 0.075));
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
function snapGroupToCenter(node, bgWidth, bgHeight, effectiveScale) {
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

function makeDefaultGlass(bgW, bgH) {
  const w = bgW * 0.4;
  const h = bgH * 0.22;
  return {
    x: (bgW - w) / 2, y: (bgH - h) / 2,
    width: w, height: h, scaleX: 1, scaleY: 1, rotation: 0,
    cornerRadius: Math.min(w, h) * 0.14,
    opacity: 0.28, thickness: 45,
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** One draggable+resizable overlay (a title card or logo layer) on the
 * poster canvas - a thin wrapper around Konva's own drag/Transformer
 * handles. `layer` is one entry of the `titleLayers`/`logoLayers` arrays
 * (see PosterConstructor); several can point at the same source `image`
 * independently (duplicated via the layer toolbar), each with its own
 * position/scale/rotation/crop/effects.
 *
 * Crop editing is a second mode on the same Group rather than a separate
 * component: while `isCropEditing`, the whole-layer Transformer is swapped
 * for a `crop-editor`-named Rect+Transformer (resize only, no rotate) that
 * edits `layer.crop` (natural image-pixel units) directly, drawn over a
 * dimmed full-resolution copy of the image so parts outside the current
 * crop are visible again to crop back in. Both the ghost and the crop
 * editor are named `crop-editor` purely so handleSave's export pass can
 * find-and-hide them in one call - they must never leak into a saved PNG. */
function OverlayImage({
  image, layer, isSelected, isCropEditing, onSelect, onChange, onCropChange,
  bgWidth, bgHeight, effectiveScale, setGuides,
}) {
  const groupRef = useRef(null);
  const trRef = useRef(null);
  const cropRectRef = useRef(null);
  const cropTrRef = useRef(null);
  const cloneRef = useRef(null);

  useEffect(() => {
    if (isSelected && !isCropEditing && trRef.current && groupRef.current) {
      trRef.current.nodes([groupRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected, isCropEditing]);

  useEffect(() => {
    if (isCropEditing && cropTrRef.current && cropRectRef.current) {
      cropTrRef.current.nodes([cropRectRef.current]);
      cropTrRef.current.getLayer()?.batchDraw();
    }
  }, [isCropEditing]);

  const effects = layer?.effects || makeDefaultEffects();
  const { glow, clone } = effects;
  useCloneBlur(cloneRef, clone, [image, layer?.crop]);

  if (!image || !layer) return null;
  const opacity = effects.opacity ?? 1;
  const naturalW = image.width;
  const naturalH = image.height;
  const crop = layer.crop;
  const boxW = crop ? crop.width : naturalW;
  const boxH = crop ? crop.height : naturalH;
  const glowOffset = glow.distance * 0.7071;
  const { count: glowPassCount, perPassOpacity: glowPassOpacity } = glowPasses(glow);

  function clampCropNode(node) {
    const w = Math.max(10, Math.min(node.width() * node.scaleX(), naturalW));
    const h = Math.max(10, Math.min(node.height() * node.scaleY(), naturalH));
    node.scaleX(1);
    node.scaleY(1);
    node.width(w);
    node.height(h);
    const x = Math.max(0, Math.min(node.x(), naturalW - w));
    const y = Math.max(0, Math.min(node.y(), naturalH - h));
    node.x(x);
    node.y(y);
    return { x, y, width: w, height: h };
  }

  return (
    <>
      <Group
        ref={groupRef}
        x={layer.x} y={layer.y}
        scaleX={layer.scaleX} scaleY={layer.scaleY}
        rotation={layer.rotation}
        draggable={!isCropEditing}
        onClick={onSelect} onTap={onSelect}
        onDragMove={(e) => setGuides(snapGroupToCenter(e.target, bgWidth, bgHeight, effectiveScale))}
        onDragEnd={(e) => { setGuides({ v: false, h: false }); onChange({ x: e.target.x(), y: e.target.y() }); }}
        onTransformEnd={() => {
          const node = groupRef.current;
          if (!node) return;
          onChange({ x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() });
        }}
      >
        {clone.enabled && (
          <Group ref={cloneRef} name="clone-blur" x={clone.offsetX} y={clone.offsetY}>
            {Array.from({ length: glowPassCount }).map((_, i) => (
              <KonvaImage
                key={i}
                image={image}
                crop={crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : undefined}
                width={boxW} height={boxH}
                opacity={clone.opacity}
                shadowEnabled={glow.enabled}
                shadowColor={glow.color} shadowBlur={glow.blur}
                shadowOffsetX={glowOffset} shadowOffsetY={glowOffset}
                shadowOpacity={glowPassOpacity}
              />
            ))}
          </Group>
        )}
        {Array.from({ length: glowPassCount }).map((_, i) => (
          <KonvaImage
            key={i}
            image={image}
            crop={crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : undefined}
            width={boxW} height={boxH}
            opacity={opacity}
            shadowEnabled={glow.enabled}
            shadowColor={glow.color} shadowBlur={glow.blur}
            shadowOffsetX={glowOffset} shadowOffsetY={glowOffset}
            shadowOpacity={glowPassOpacity}
          />
        ))}
        {isCropEditing && (
          <>
            <KonvaImage name="crop-editor" image={image} width={naturalW} height={naturalH} opacity={0.3} listening={false} />
            <Rect
              ref={cropRectRef} name="crop-editor"
              x={crop?.x ?? 0} y={crop?.y ?? 0} width={crop?.width ?? naturalW} height={crop?.height ?? naturalH}
              stroke="#ff9d5c" strokeWidth={2} fill="rgba(255,157,92,0.12)"
              draggable
              onDragMove={(e) => {
                const node = e.target;
                const w = node.width();
                const h = node.height();
                node.x(Math.max(0, Math.min(node.x(), naturalW - w)));
                node.y(Math.max(0, Math.min(node.y(), naturalH - h)));
              }}
              onDragEnd={(e) => onCropChange({ x: e.target.x(), y: e.target.y(), width: e.target.width(), height: e.target.height() })}
              onTransformEnd={() => {
                const node = cropRectRef.current;
                if (!node) return;
                onCropChange(clampCropNode(node));
              }}
            />
            <Transformer
              name="crop-editor" ref={cropTrRef}
              rotateEnabled={false}
              enabledAnchors={[
                'top-left', 'top-center', 'top-right',
                'middle-left', 'middle-right',
                'bottom-left', 'bottom-center', 'bottom-right',
              ]}
              boundBoxFunc={(oldBox, newBox) => (newBox.width < 20 || newBox.height < 20 ? oldBox : newBox)}
            />
          </>
        )}
      </Group>
      {isSelected && !isCropEditing && (
        <Transformer
          ref={trRef}
          rotateEnabled
          enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
          boundBoxFunc={(oldBox, newBox) => (newBox.width < 10 || newBox.height < 10 ? oldBox : newBox)}
        />
      )}
    </>
  );
}

/** A draggable+resizable "frosted glass" panel object - a plain rounded
 * rect, not tied to any source image. Cheap live-preview look only (white
 * tint + soft edge highlight); the real blurred-background version is
 * baked in at save time (see handleSave's glassNode substitution), since a
 * true backdrop blur redrawn on every drag frame would be too slow. Found
 * at save time via its Konva `name` ('glass-group') rather than a ref, to
 * avoid extra ref plumbing between this component and PosterConstructor. */
function OverlayGlass({ transform, isSelected, onSelect, onChange, bgWidth, bgHeight, effectiveScale, setGuides }) {
  const groupRef = useRef(null);
  const trRef = useRef(null);

  useEffect(() => {
    if (isSelected && trRef.current && groupRef.current) {
      trRef.current.nodes([groupRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected]);

  if (!transform) return null;
  const { width: w, height: h, cornerRadius, opacity, thickness } = transform;
  const strokeWidth = 1 + (thickness / 100) * 3;
  const strokeOpacity = 0.25 + (thickness / 100) * 0.5;
  const shadowBlur = (thickness / 100) * 24;

  return (
    <>
      <Group
        ref={groupRef}
        name="glass-group"
        x={transform.x} y={transform.y}
        scaleX={transform.scaleX} scaleY={transform.scaleY}
        rotation={transform.rotation}
        draggable
        onClick={onSelect} onTap={onSelect}
        onDragMove={(e) => setGuides(snapGroupToCenter(e.target, bgWidth, bgHeight, effectiveScale))}
        onDragEnd={(e) => {
          setGuides({ v: false, h: false });
          onChange({ ...transform, x: e.target.x(), y: e.target.y() });
        }}
        onTransformEnd={() => {
          const node = groupRef.current;
          if (!node) return;
          onChange({ ...transform, x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() });
        }}
      >
        <Rect
          width={w} height={h} cornerRadius={cornerRadius}
          fill="#ffffff" opacity={opacity}
          shadowColor="#000000" shadowBlur={shadowBlur} shadowOpacity={0.25} shadowOffsetY={shadowBlur * 0.25}
        />
        <Rect
          width={w} height={h} cornerRadius={cornerRadius}
          stroke="#ffffff" strokeWidth={strokeWidth} opacity={strokeOpacity}
        />
      </Group>
      {isSelected && (
        <Transformer
          ref={trRef}
          rotateEnabled
          enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
          boundBoxFunc={(oldBox, newBox) => (newBox.width < 20 || newBox.height < 20 ? oldBox : newBox)}
        />
      )}
    </>
  );
}

/** One draggable+resizable text overlay - either a `badge` (a black pill
 * behind white text, e.g. an author credit) or a `halo` (bare large text
 * with a soft drop-shadow, e.g. a title) - see `makeTextLayer`. Shares the
 * exact drag/transform/center-snap skeleton with `OverlayImage`/
 * `OverlayGlass`; the halo's "shadow around itself" look reuses the same
 * `effects.glow` shadow mechanism `OverlayImage` already has for images
 * (Konva `Text` exposes the same `shadow*` props as `Image`), rather than
 * a second duplicated text node.
 *
 * The badge's pill `Rect` has to hug the text, but Konva only knows a
 * `Text` node's rendered size once the font is actually loaded and the
 * node has painted - so its size is read back via a ref after each
 * paint-affecting prop change, plus once more when `document.fonts.ready`
 * resolves (in case this render raced the Google Fonts `<link>`). */
function OverlayText({ layer, isSelected, onSelect, onChange, bgWidth, bgHeight, effectiveScale, setGuides }) {
  const groupRef = useRef(null);
  const textRef = useRef(null);
  const trRef = useRef(null);
  const cloneRef = useRef(null);
  const [box, setBox] = useState({ w: 10, h: 10 });

  useEffect(() => {
    if (isSelected && trRef.current && groupRef.current) {
      trRef.current.nodes([groupRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected]);

  useEffect(() => {
    function measure() {
      const node = textRef.current;
      // getTextWidth()/height() read the text's actual rendered size,
      // ignoring the `width` we feed the node below to make `align` work -
      // width() would otherwise just echo that fed-in value back.
      if (node) setBox({ w: node.getTextWidth(), h: node.height() });
    }
    measure();
    if (document.fonts?.ready) document.fonts.ready.then(measure);
  }, [layer.text, layer.fontFamily, layer.fontSize]);

  const effects = layer?.effects || makeDefaultEffects();
  const { glow, clone } = effects;
  useCloneBlur(cloneRef, clone, [layer?.text, layer?.fontFamily, layer?.fontSize, box.w, box.h]);

  if (!layer) return null;
  const isBadge = layer.textType === 'badge';
  const opacity = effects.opacity ?? 1;
  const glowOffset = glow.distance * 0.7071;
  const padX = isBadge ? layer.fontSize * 0.6 : 0;
  const padY = isBadge ? layer.fontSize * 0.38 : 0;
  const pillH = box.h + padY * 2;
  const { count: glowPassCount, perPassOpacity: glowPassOpacity } = glowPasses(glow);

  return (
    <>
      <Group
        ref={groupRef}
        x={layer.x} y={layer.y}
        scaleX={layer.scaleX} scaleY={layer.scaleY}
        rotation={layer.rotation}
        opacity={opacity}
        draggable
        onClick={onSelect} onTap={onSelect}
        onDragMove={(e) => setGuides(snapGroupToCenter(e.target, bgWidth, bgHeight, effectiveScale))}
        onDragEnd={(e) => { setGuides({ v: false, h: false }); onChange({ x: e.target.x(), y: e.target.y() }); }}
        onTransformEnd={() => {
          const node = groupRef.current;
          if (!node) return;
          onChange({ x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() });
        }}
      >
        {clone.enabled && (
          <Group ref={cloneRef} name="clone-blur" x={clone.offsetX} y={clone.offsetY} opacity={clone.opacity}>
            {isBadge && (
              <Rect width={box.w + padX * 2} height={pillH} cornerRadius={pillH / 2} fill={layer.bgColor} />
            )}
            {Array.from({ length: isBadge ? 1 : glowPassCount }).map((_, i) => (
              <Text
                key={i}
                x={padX} y={padY}
                width={box.w} wrap="none" align={layer.align || 'left'}
                text={layer.text}
                fontFamily={layer.fontFamily}
                fontSize={layer.fontSize}
                fill={layer.color}
                shadowEnabled={!isBadge && glow.enabled}
                shadowColor={glow.color} shadowBlur={glow.blur}
                shadowOffsetX={glowOffset} shadowOffsetY={glowOffset}
                shadowOpacity={glowPassOpacity}
              />
            ))}
          </Group>
        )}
        {isBadge && (
          <Rect width={box.w + padX * 2} height={pillH} cornerRadius={pillH / 2} fill={layer.bgColor} />
        )}
        {Array.from({ length: isBadge ? 1 : glowPassCount }).map((_, i, arr) => (
          <Text
            key={i}
            ref={i === arr.length - 1 ? textRef : undefined}
            x={padX} y={padY}
            width={box.w} wrap="none" align={layer.align || 'left'}
            text={layer.text}
            fontFamily={layer.fontFamily}
            fontSize={layer.fontSize}
            fill={layer.color}
            shadowEnabled={!isBadge && glow.enabled}
            shadowColor={glow.color} shadowBlur={glow.blur}
            shadowOffsetX={glowOffset} shadowOffsetY={glowOffset}
            shadowOpacity={glowPassOpacity}
          />
        ))}
      </Group>
      {isSelected && (
        <Transformer
          ref={trRef}
          rotateEnabled
          enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
          boundBoxFunc={(oldBox, newBox) => (newBox.width < 10 || newBox.height < 10 ? oldBox : newBox)}
        />
      )}
    </>
  );
}

function EffectSlider({ label, value, min, max, step = 1, unit = '', onChange }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
      <span style={{ color: 'var(--text-dim)', display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span>{value}{unit}</span>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#ff9d5c' }}
      />
    </label>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-dim)' }}>
      <span style={{ flex: 1 }}>{label}</span>
      <input
        type="color" value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: 28, height: 22, padding: 0, border: 'none', borderRadius: 4, background: 'none', cursor: 'pointer' }}
      />
    </label>
  );
}

/** Property controls for the currently selected overlay layer (title card
 * or logo): the layer's own opacity, plus an optional glow (shadow cast by
 * the image's own alpha shape - color/blur/distance/intensity). Mirrors
 * Canva's shadow-effect controls, which is what glow was modeled after. */
function EffectsPanel({ label, effects, onChange, L }) {
  const { glow, clone } = effects;
  const opacity = effects.opacity ?? 1;
  const patchGlow = (p) => onChange({ ...effects, glow: { ...glow, ...p } });
  const patchClone = (p) => onChange({ ...effects, clone: { ...clone, ...p } });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div className="scene-prompt-label">{label}</div>

      <EffectSlider
        label={L.poster_effect_opacity} value={Math.round(opacity * 100)} min={5} max={100} unit="%"
        onChange={(v) => onChange({ ...effects, opacity: v / 100 })}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={glow.enabled} onChange={(e) => patchGlow({ enabled: e.target.checked })} />
          {L.poster_effect_glow}
        </label>
        {glow.enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20 }}>
            <ColorField label={L.poster_effect_color} value={glow.color} onChange={(v) => patchGlow({ color: v })} />
            <EffectSlider label={L.poster_effect_blur} value={glow.blur} min={0} max={250} onChange={(v) => patchGlow({ blur: v })} />
            <EffectSlider label={L.poster_effect_distance} value={glow.distance} min={0} max={200} onChange={(v) => patchGlow({ distance: v })} />
            <EffectSlider
              label={L.poster_effect_intensity} value={Math.round((glow.opacity / 5) * 100)} min={0} max={100} unit="%"
              onChange={(v) => patchGlow({ opacity: (v / 100) * 5 })}
            />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={clone.enabled} onChange={(e) => patchClone({ enabled: e.target.checked })} />
          {L.poster_effect_clone}
        </label>
        {clone.enabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 20 }}>
            <EffectSlider label={L.poster_effect_cloneOffsetX} value={clone.offsetX} min={-100} max={100} unit="px" onChange={(v) => patchClone({ offsetX: v })} />
            <EffectSlider label={L.poster_effect_cloneOffsetY} value={clone.offsetY} min={-100} max={100} unit="px" onChange={(v) => patchClone({ offsetY: v })} />
            <EffectSlider
              label={L.poster_effect_cloneOpacity} value={Math.round(clone.opacity * 100)} min={5} max={100} unit="%"
              onChange={(v) => patchClone({ opacity: v / 100 })}
            />
            <EffectSlider label={L.poster_effect_cloneBlur} value={clone.blur} min={0} max={40} onChange={(v) => patchClone({ blur: v })} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Duplicate/crop/delete toolbar for the selected title or logo layer -
 * duplicate clones the layer (offset slightly, independently movable from
 * then on); crop toggles OverlayImage's crop-editing mode; delete only
 * shows once there's more than one layer of that kind, so the last
 * remaining title/logo layer can't be deleted into an empty (and then
 * auto-refilled - see PosterConstructor's default-placement effects)
 * state via this button. */
function LayerToolbar({ layer, siblingCount, isCropEditing, allowCrop = true, onDuplicate, onDelete, onToggleCrop, onResetCrop, L }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {!isCropEditing && (
        <button className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5 }} onClick={onDuplicate}>
          <Copy size={12} />
          {L.poster_duplicate}
        </button>
      )}
      {allowCrop && (
        <button className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5 }} onClick={onToggleCrop}>
          <Crop size={12} />
          {isCropEditing ? L.poster_cropDone : L.poster_crop}
        </button>
      )}
      {allowCrop && layer.crop && !isCropEditing && (
        <button className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5 }} onClick={onResetCrop}>
          <RotateCcw size={12} />
          {L.poster_cropReset}
        </button>
      )}
      {siblingCount > 1 && !isCropEditing && (
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onDelete} title={L.poster_deleteLayer}>
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/** Property controls for the glass panel object: opacity, "thickness"
 * (drives edge-highlight strength and drop shadow, both in OverlayGlass's
 * live preview and in the real blurred version baked in at save), and
 * corner radius. */
function GlassPanel({ glass, onChange, onRemove, L }) {
  const maxCorner = Math.round(Math.min(glass.width * glass.scaleX, glass.height * glass.scaleY) / 2);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="scene-prompt-label">{L.poster_glassLabel}</div>
        <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={onRemove} title={L.poster_glassRemove}>
          <Trash2 size={12} />
        </button>
      </div>
      <EffectSlider
        label={L.poster_glassOpacity} value={Math.round(glass.opacity * 100)} min={5} max={90} unit="%"
        onChange={(v) => onChange({ ...glass, opacity: v / 100 })}
      />
      <EffectSlider
        label={L.poster_glassThickness} value={glass.thickness} min={0} max={100}
        onChange={(v) => onChange({ ...glass, thickness: v })}
      />
      <EffectSlider
        label={L.poster_glassCorner} value={Math.round(glass.cornerRadius)} min={0} max={maxCorner}
        onChange={(v) => onChange({ ...glass, cornerRadius: v })}
      />
    </div>
  );
}

/** Content/typography controls for the selected text layer (badge or
 * halo) - text content, font family (`FONT_OPTIONS`), size, and text
 * color, plus the pill color when the layer is a badge. The shared
 * opacity/glow controls stay in `EffectsPanel`, rendered separately right
 * after this panel - this one only owns the text-specific fields. */
function TextLayerPanel({ layer, onChange, L }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
      <div className="scene-prompt-label">{layer.textType === 'badge' ? L.poster_textBadgeLabel : L.poster_textHaloLabel}</div>
      <textarea
        value={layer.text}
        onChange={(e) => onChange({ text: e.target.value })}
        rows={2}
        style={{
          width: '100%', resize: 'vertical', fontSize: 12, padding: 6, borderRadius: 6,
          background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-dim)' }}>
        {L.poster_textAlignLabel}
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { value: 'left', Icon: AlignLeft, title: L.poster_alignLeft },
            { value: 'center', Icon: AlignCenter, title: L.poster_alignCenter },
            { value: 'right', Icon: AlignRight, title: L.poster_alignRight },
          ].map(({ value, Icon, title }) => (
            <button
              key={value}
              className="icon-btn"
              style={{
                width: 28, height: 26,
                background: (layer.align || 'left') === value ? 'rgba(255,157,92,0.25)' : undefined,
                border: (layer.align || 'left') === value ? '1px solid #ff9d5c' : undefined,
              }}
              title={title}
              onClick={() => onChange({ align: value })}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-dim)' }}>
        {L.poster_fontLabel}
        <select
          value={layer.fontFamily}
          onChange={(e) => onChange({ fontFamily: e.target.value })}
          style={{ padding: 6, borderRadius: 6, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff' }}
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value} style={{ color: '#000' }}>{f.label}</option>
          ))}
        </select>
      </label>
      <EffectSlider
        label={L.poster_fontSizeLabel} value={layer.fontSize} min={10} max={400}
        onChange={(v) => onChange({ fontSize: v })}
      />
      <ColorField label={L.poster_textColorLabel} value={layer.color} onChange={(v) => onChange({ color: v })} />
      {layer.textType === 'badge' && (
        <ColorField label={L.poster_badgeColorLabel} value={layer.bgColor} onChange={(v) => onChange({ bgColor: v })} />
      )}
    </div>
  );
}

/** One picker section (background/title card/logo/objects) in the side
 * panel. `collapsible` lets the user fold sections they're done with to
 * keep the fixed-width panel compact - collapse state is local (not lifted
 * to PosterConstructor) since nothing outside this row needs it. */
function PickerRow({ label, children, scrollable, collapsible, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = !collapsible || open;
  return (
    <div>
      <div
        className="scene-prompt-label"
        style={{
          marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: collapsible ? 'pointer' : 'default',
        }}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
      >
        <span>{label}</span>
        {collapsible && (open ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
      </div>
      {isOpen && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', ...(scrollable ? { maxHeight: 140, overflowY: 'auto' } : {}) }}>
          {children}
        </div>
      )}
    </div>
  );
}

function PickerThumb({ selected, onClick, title, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: 0, borderRadius: 6, width: 56, height: 56, flexShrink: 0, cursor: 'pointer',
        background: 'rgba(255,255,255,0.04)',
        border: selected ? '2px solid #ff9d5c' : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {children}
    </button>
  );
}

/** Composites a background (a scene/reference image already generated in an
 * earlier stage) with a title-card overlay and an optional logo, positioned
 * and scaled by dragging Konva Transformer handles - the actual "afisha"
 * (poster), as opposed to the Title Card stage's "Generate title" button
 * which only produces the typographic overlay itself. Saving flattens the
 * Konva stage to a PNG client-side (no server-side image compositing
 * dependency needed) and uploads it alongside the layer transforms, so
 * `onEdit` can reopen this exact same arrangement later. */
export default function PosterConstructor({
  L, projectId, candidates, variants, logos, initialPoster, saving, onSave, onClose, textBlock,
  posterTemplates = [], onSaveTemplate, onDeleteTemplate,
}) {
  const [backgroundPath, setBackgroundPath] = useState(initialPoster?.background_path || candidates[0] || null);
  const [titleCardVariantId, setTitleCardVariantId] = useState(initialPoster?.title_card_variant_id || variants[0]?.variant_id || null);
  const [logoId, setLogoId] = useState(initialPoster?.logo_id || null);
  const [titleLayers, setTitleLayers] = useState(() => normalizeLayers(initialPoster?.layers?.title_card));
  const [logoLayers, setLogoLayers] = useState(() => normalizeLayers(initialPoster?.layers?.logo));
  const [glassLayer, setGlassLayer] = useState(initialPoster?.layers?.glass || null);
  const [textLayers, setTextLayers] = useState(() => normalizeTextLayers(initialPoster?.layers?.text));
  const [selected, setSelected] = useState(null); // {kind:'title'|'logo'|'text', id} | {kind:'glass'} | null
  const [cropEditing, setCropEditing] = useState(null); // {kind, id} | null
  const [fullscreen, setFullscreen] = useState(false);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [zoom, setZoom] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [guides, setGuides] = useState({ v: false, h: false });
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [templateNameDraft, setTemplateNameDraft] = useState('');
  const lastCommitAt = useRef(0);
  const stageRef = useRef(null);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fullscreen]);

  // A zoom/pan applied under one background/one screen size doesn't mean
  // anything once either changes - start fresh rather than leaving the view
  // panned off into empty space.
  useEffect(() => {
    setZoom(1);
    setStagePos({ x: 0, y: 0 });
  }, [fullscreen, backgroundPath]);

  // `?canvas` distinguishes these fetches from the plain <img> tags the
  // picker thumbnails below use for the exact same URLs - two different
  // fetch modes (plain <img> vs useHtmlImage's CORS-mode fetch, see its
  // docstring) racing for the same URL at mount time was observed to fail
  // one of them with net::ERR_FAILED (confirmed in this app's dev session,
  // 2026-08); the query string is ignored by the backend's static file
  // serving, so this only affects the browser's cache key, not the request.
  const bg = useHtmlImage(backgroundPath ? `${mediaUrl(`projects/${projectId}/${backgroundPath}`)}?canvas` : null);
  const titleVariant = variants.find((v) => v.variant_id === titleCardVariantId);
  const titleImg = useHtmlImage(titleVariant ? `${mediaUrl(`projects/${projectId}/${titleVariant.file_path}`)}?canvas` : null);
  const logo = logos.find((l) => l.id === logoId);
  const logoImg = useHtmlImage(logo ? `${mediaUrl(logo.file_path)}?canvas` : null);

  // In fullscreen, the picture area grows to fill essentially the whole
  // viewport (the side panel itself stays SIDE_PANEL_WIDTH wide - see its
  // style below - rather than also growing and eating the extra space).
  const maxDisplayW = fullscreen ? Math.max(320, viewport.w - SIDE_PANEL_RESERVE) : MAX_DISPLAY_W;
  const maxDisplayH = fullscreen ? Math.max(240, viewport.h - FULLSCREEN_V_RESERVE) : MAX_DISPLAY_H;
  const scale = bg.width ? Math.min(1, maxDisplayW / bg.width, maxDisplayH / bg.height) : 1;
  const displayW = Math.round((bg.width || maxDisplayW) * scale);
  const displayH = Math.round((bg.height || maxDisplayH) * scale);
  const overflowMargin = fullscreen ? OVERFLOW_MARGIN_FULLSCREEN : OVERFLOW_MARGIN;
  const marginLocal = scale ? overflowMargin / scale : 0;
  const effectiveScale = scale * zoom;
  const stageW = displayW + overflowMargin * 2;
  const stageH = displayH + overflowMargin * 2;

  // Default-place a freshly picked overlay (no layers yet) once both its
  // image and the background's natural size are known.
  useEffect(() => {
    if (titleImg.image && titleLayers.length === 0 && bg.width) {
      const s = (bg.width * 0.6) / titleImg.width;
      setTitleLayers([makeLayer({
        x: (bg.width - titleImg.width * s) / 2, y: (bg.height - titleImg.height * s) / 2,
        scaleX: s, scaleY: s,
      })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleImg.image, bg.width]);

  useEffect(() => {
    if (logoImg.image && logoId && logoLayers.length === 0 && bg.width) {
      const s = (bg.width * 0.18) / logoImg.width;
      setLogoLayers([makeLayer({ x: bg.width * 0.04, y: bg.height * 0.04, scaleX: s, scaleY: s })]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoImg.image, logoId, bg.width]);

  /** Undo/redo: a single choke point every document mutation runs through.
   * Snapshots the pre-mutation document into `past` (clearing `future`,
   * since a fresh edit invalidates any redo branch) before applying
   * `mutate` - unless the previous commit was under 400ms ago, in which
   * case it's coalesced into that same snapshot instead of pushing a new
   * one. That coalescing is what keeps a single slider/color/text-field
   * drag (which re-fires this on every tick) from flooding the history
   * with one entry per pixel/keystroke - see the plan's rationale. */
  function currentDoc() {
    return { backgroundPath, titleCardVariantId, logoId, titleLayers, logoLayers, glassLayer, textLayers };
  }
  function applyDoc(doc) {
    setBackgroundPath(doc.backgroundPath);
    setTitleCardVariantId(doc.titleCardVariantId);
    setLogoId(doc.logoId);
    setTitleLayers(doc.titleLayers);
    setLogoLayers(doc.logoLayers);
    setGlassLayer(doc.glassLayer);
    setTextLayers(doc.textLayers);
  }
  function commit(mutate) {
    const now = Date.now();
    if (now - lastCommitAt.current > 400) {
      setPast((p) => [...p, currentDoc()].slice(-MAX_HISTORY));
      setFuture([]);
    }
    lastCommitAt.current = now;
    mutate();
  }
  function undo() {
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    setFuture((f) => [currentDoc(), ...f]);
    setPast((p) => p.slice(0, -1));
    applyDoc(prev);
    lastCommitAt.current = 0;
    setSelected(null);
    setCropEditing(null);
  }
  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setPast((p) => [...p, currentDoc()]);
    setFuture((f) => f.slice(1));
    applyDoc(next);
    lastCommitAt.current = 0;
    setSelected(null);
    setCropEditing(null);
  }

  useEffect(() => {
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // undo/redo intentionally omitted: they're recreated every render but only
    // *do* anything different once past/future change, so resubscribing on
    // those two (rather than every render - e.g. every drag-guide update) is
    // the actual intent, not an oversight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, future]);

  function pickBackground(path) { commit(() => setBackgroundPath(path)); }
  function pickTitleCard(variantId) {
    commit(() => {
      setTitleCardVariantId(variantId);
      setTitleLayers([]);
      setSelected(null);
      setCropEditing(null);
    });
  }
  function pickLogo(id) {
    commit(() => {
      setLogoId(id);
      setLogoLayers([]);
      setSelected(null);
      setCropEditing(null);
    });
  }
  function addGlass() {
    if (!bg.width || glassLayer) return;
    commit(() => { setGlassLayer(makeDefaultGlass(bg.width, bg.height)); setSelected({ kind: 'glass' }); });
  }
  function removeGlass() {
    commit(() => { setGlassLayer(null); setSelected((s) => (s?.kind === 'glass' ? null : s)); });
  }

  function addTextLayer(textType) {
    if (!bg.width) return;
    commit(() => {
      const defaults = parseTextBlock(textBlock);
      const fallback = { title: L.poster_defaultTitleText, author: L.poster_defaultAuthorText };
      const layer = makeTextLayer(textType, bg, defaults, fallback);
      setTextLayers((list) => [...list, layer]);
      setSelected({ kind: 'text', id: layer.id });
    });
  }

  /** Applies a saved poster template (logo + glass + text layers only -
   * see settings.py's `poster_templates` doc comment for why the background
   * and title-card layers are deliberately excluded, they're specific to
   * the poem this poster happens to be for). Regenerates fresh layer ids so
   * the applied copies are independently editable from whatever the
   * template itself might still be re-applied onto later. */
  function applyTemplate(id) {
    const tpl = posterTemplates.find((t) => t.id === id);
    if (!tpl?.layers) return;
    commit(() => {
      const { layers } = tpl;
      setLogoId(layers.logo_id ?? null);
      setLogoLayers(normalizeLayers(layers.logo).map((l) => ({ ...l, id: genId() })));
      setGlassLayer(layers.glass ? { ...layers.glass } : null);
      setTextLayers(normalizeTextLayers(layers.text).map((l) => ({ ...l, id: genId() })));
      setSelected(null);
      setCropEditing(null);
    });
  }

  function saveCurrentAsTemplate() {
    const trimmed = templateNameDraft.trim();
    if (!trimmed || !onSaveTemplate) return;
    onSaveTemplate(trimmed, { logo_id: logoId, logo: logoLayers, glass: glassLayer, text: textLayers });
    setTemplateNameDraft('');
  }

  function layerListFor(kind) {
    if (kind === 'title') return [titleLayers, setTitleLayers];
    if (kind === 'logo') return [logoLayers, setLogoLayers];
    return [textLayers, setTextLayers];
  }

  function updateLayer(kind, id, patch) {
    commit(() => {
      const [, setList] = layerListFor(kind);
      setList((list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    });
  }

  function duplicateLayer(kind, id) {
    commit(() => {
      const [list, setList] = layerListFor(kind);
      const src = list.find((l) => l.id === id);
      if (!src) return;
      const copy = {
        ...src, id: genId(), x: src.x + 24, y: src.y + 24,
        effects: { glow: { ...src.effects.glow }, clone: { ...src.effects.clone }, opacity: src.effects.opacity },
        ...(kind !== 'text' ? { crop: src.crop ? { ...src.crop } : null } : {}),
      };
      setList([...list, copy]);
      setSelected({ kind, id: copy.id });
      setCropEditing(null);
    });
  }

  function deleteLayer(kind, id) {
    commit(() => {
      const [, setList] = layerListFor(kind);
      setList((list) => list.filter((l) => l.id !== id));
      setSelected(null);
      setCropEditing(null);
    });
  }

  function zoomAtPoint(pointer, factor) {
    const oldScale = scale * zoom;
    const newZoom = clampZoom(zoom * factor);
    const newScale = scale * newZoom;
    const mousePointTo = { x: (pointer.x - stagePos.x) / oldScale, y: (pointer.y - stagePos.y) / oldScale };
    setZoom(newZoom);
    setStagePos({ x: pointer.x - mousePointTo.x * newScale, y: pointer.y - mousePointTo.y * newScale });
  }
  function handleWheel(e) {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    zoomAtPoint(pointer, e.evt.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }
  function zoomButton(factor) {
    zoomAtPoint({ x: stageW / 2, y: stageH / 2 }, factor);
  }
  function resetZoom() { setZoom(1); setStagePos({ x: 0, y: 0 }); }

  /** Builds the real (blurred) frosted-glass tile that replaces the cheap
   * live-preview tint for export. Runs once at save time only - a live
   * backdrop blur redrawn every drag frame would be too slow.
   *
   * Konva rotates a Group around its own (x,y), i.e. the panel's top-left
   * corner, not its center. Rather than hand-deriving that rotated sampling
   * transform (easy to get a sign wrong in), the background is first
   * de-rotated as a whole around that same pivot point (a plain, easily
   * verified `ctx.rotate` around a fixed point), which leaves the glass
   * panel's footprint sitting axis-aligned at that pivot - then it's just a
   * rectangular crop. */
  function buildHqGlassCanvas(bigCanvas, glass, exportRatio, marginPx) {
    const pivotX = marginPx + glass.x;
    const pivotY = marginPx + glass.y;
    const localW = Math.max(1, Math.round(glass.width * glass.scaleX));
    const localH = Math.max(1, Math.round(glass.height * glass.scaleY));
    const rotRad = (glass.rotation * Math.PI) / 180;

    const derotated = document.createElement('canvas');
    derotated.width = bigCanvas.width;
    derotated.height = bigCanvas.height;
    const dctx = derotated.getContext('2d');
    dctx.translate(pivotX, pivotY);
    dctx.rotate(-rotRad);
    dctx.translate(-pivotX, -pivotY);
    dctx.drawImage(bigCanvas, 0, 0);

    const target = document.createElement('canvas');
    target.width = localW;
    target.height = localH;
    const tctx = target.getContext('2d');
    const blurPx = (glass.thickness / 100) * 18 * exportRatio;
    tctx.filter = blurPx > 0.1 ? `blur(${blurPx}px)` : 'none';
    tctx.drawImage(derotated, pivotX, pivotY, localW, localH, 0, 0, localW, localH);
    tctx.filter = 'none';

    const r = Math.min(glass.cornerRadius * glass.scaleX, localW / 2, localH / 2);
    roundRectPath(tctx, 0, 0, localW, localH, r);
    tctx.save();
    tctx.clip();
    tctx.fillStyle = `rgba(255,255,255,${glass.opacity})`;
    tctx.fillRect(0, 0, localW, localH);
    tctx.restore();

    const strokeWidth = (1 + (glass.thickness / 100) * 3) * exportRatio;
    const strokeOpacity = 0.25 + (glass.thickness / 100) * 0.5;
    tctx.lineWidth = strokeWidth;
    tctx.strokeStyle = `rgba(255,255,255,${strokeOpacity})`;
    roundRectPath(tctx, strokeWidth / 2, strokeWidth / 2, localW - strokeWidth, localH - strokeWidth, Math.max(0, r - strokeWidth / 2));
    tctx.stroke();

    return { canvas: target, localW, localH };
  }

  async function handleSave() {
    if (!backgroundPath || !titleCardVariantId || !bg.width || !stageRef.current) return;
    const stage = stageRef.current;
    const exportRatio = bg.width / displayW;
    const glassNode = glassLayer ? stage.findOne('.glass-group') : null;
    let hqImage = null;

    // The interactive zoom/pan is a view-only convenience - export always
    // renders the poster at its true fit scale and neutral position, same
    // as the crop/x/y math below (which assumes exactly that state).
    const prevScale = stage.scaleX();
    const prevPos = stage.position();
    stage.scale({ x: scale, y: scale });
    stage.position({ x: 0, y: 0 });

    // A selected layer's Transformer (drag/rotate handles) and any
    // in-progress crop editor are live Konva nodes in the same Layer being
    // flattened - hide them for the export or they bake into the saved PNG.
    const transformers = stage.find('Transformer');
    transformers.forEach((t) => t.hide());
    const cropEditorNodes = stage.find('.crop-editor');
    cropEditorNodes.forEach((n) => n.hide());

    if (glassNode) {
      glassNode.hide();
      stage.batchDraw();
      // Explicit x/y/width/height: toCanvas defaults to the stage's content
      // bounding box (via getClientRect) when omitted, which can start at a
      // non-zero origin - pinning it to the stage's own pixel rect keeps
      // this canvas's (0,0) matching the pivot math below.
      const bigCanvas = stage.toCanvas({ x: 0, y: 0, width: stage.width(), height: stage.height(), pixelRatio: exportRatio });
      const marginPx = overflowMargin * exportRatio;
      const { canvas, localW, localH } = buildHqGlassCanvas(bigCanvas, glassLayer, exportRatio, marginPx);
      hqImage = new Konva.Image({
        image: canvas, x: glassLayer.x, y: glassLayer.y, width: localW, height: localH, rotation: glassLayer.rotation,
      });
      const parent = glassNode.getParent();
      parent.add(hqImage);
      hqImage.setZIndex(glassNode.getZIndex());
      stage.batchDraw();
    }

    const blob = await stage.toBlob({
      x: overflowMargin, y: overflowMargin, width: displayW, height: displayH,
      pixelRatio: exportRatio, mimeType: 'image/png',
    });

    if (hqImage) hqImage.destroy();
    if (glassNode) glassNode.show();
    transformers.forEach((t) => t.show());
    cropEditorNodes.forEach((n) => n.show());
    stage.scale({ x: prevScale, y: prevScale });
    stage.position(prevPos);
    stage.batchDraw();

    onSave({
      blob, backgroundPath, titleCardVariantId, logoId,
      canvasSize: { width: bg.width, height: bg.height },
      layers: { title_card: titleLayers, logo: logoId ? logoLayers : null, glass: glassLayer, text: textLayers },
      posterId: initialPoster?.poster_id,
    });
  }

  const panelStyle = fullscreen
    // paddingTop reserves room for the floating Minimize2/X buttons
    // (top:10 + 30px tall, see the fullscreen branch below), which sit
    // directly over this panel's top-right corner and would otherwise
    // overlap the zoom/undo row that used to be the panel's first child.
    ? {
      flex: `0 0 ${SIDE_PANEL_WIDTH}px`, width: SIDE_PANEL_WIDTH, display: 'flex', flexDirection: 'column', gap: 14,
      overflowY: 'auto', minHeight: 0, paddingTop: 48,
    }
    : { flex: '1 1 220px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 14 };

  const pictureBox = (
    <div style={{ position: 'relative', width: displayW, height: displayH, flexShrink: 0 }}>
      <div
        style={{
          position: 'absolute', inset: 0, borderRadius: 8, overflow: 'hidden',
          background: 'repeating-conic-gradient(#2a2a2a 0% 25%, #363636 0% 50%) 50% / 16px 16px',
        }}
      />
      {bg.image && (
        <Stage
          ref={stageRef}
          width={stageW} height={stageH}
          style={{ position: 'absolute', left: -overflowMargin, top: -overflowMargin }}
          scaleX={effectiveScale} scaleY={effectiveScale}
          x={stagePos.x} y={stagePos.y}
          onWheel={handleWheel}
          onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelected(null); }}
          onTouchStart={(e) => { if (e.target === e.target.getStage()) setSelected(null); }}
        >
          <Layer>
            <Group x={marginLocal} y={marginLocal}>
              <KonvaImage image={bg.image} width={bg.width} height={bg.height} listening={false} />
              {glassLayer && (
                <OverlayGlass
                  transform={glassLayer} isSelected={selected?.kind === 'glass'}
                  onSelect={() => setSelected({ kind: 'glass' })} onChange={(next) => commit(() => setGlassLayer(next))}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              )}
              {titleLayers.map((layer) => (
                <OverlayImage
                  key={layer.id}
                  image={titleImg.image} layer={layer}
                  isSelected={selected?.kind === 'title' && selected.id === layer.id}
                  isCropEditing={cropEditing?.kind === 'title' && cropEditing.id === layer.id}
                  onSelect={() => setSelected({ kind: 'title', id: layer.id })}
                  onChange={(patch) => updateLayer('title', layer.id, patch)}
                  onCropChange={(crop) => updateLayer('title', layer.id, { crop })}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {logoId && logoLayers.map((layer) => (
                <OverlayImage
                  key={layer.id}
                  image={logoImg.image} layer={layer}
                  isSelected={selected?.kind === 'logo' && selected.id === layer.id}
                  isCropEditing={cropEditing?.kind === 'logo' && cropEditing.id === layer.id}
                  onSelect={() => setSelected({ kind: 'logo', id: layer.id })}
                  onChange={(patch) => updateLayer('logo', layer.id, patch)}
                  onCropChange={(crop) => updateLayer('logo', layer.id, { crop })}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {textLayers.map((layer) => (
                <OverlayText
                  key={layer.id}
                  layer={layer}
                  isSelected={selected?.kind === 'text' && selected.id === layer.id}
                  onSelect={() => setSelected({ kind: 'text', id: layer.id })}
                  onChange={(patch) => updateLayer('text', layer.id, patch)}
                  bgWidth={bg.width} bgHeight={bg.height} effectiveScale={effectiveScale} setGuides={setGuides}
                />
              ))}
              {guides.v && (
                <Line
                  points={[bg.width / 2, 0, bg.width / 2, bg.height]}
                  stroke="#ff3b6f" strokeWidth={1.5 / effectiveScale}
                  dash={[8 / effectiveScale, 6 / effectiveScale]} listening={false}
                />
              )}
              {guides.h && (
                <Line
                  points={[0, bg.height / 2, bg.width, bg.height / 2]}
                  stroke="#ff3b6f" strokeWidth={1.5 / effectiveScale}
                  dash={[8 / effectiveScale, 6 / effectiveScale]} listening={false}
                />
              )}
            </Group>
          </Layer>
        </Stage>
      )}
    </div>
  );

  const selectedLayer = selected && (selected.kind === 'title' || selected.kind === 'logo' || selected.kind === 'text')
    ? layerListFor(selected.kind)[0].find((l) => l.id === selected.id)
    : null;
  const isEditingSelectedCrop = !!(selectedLayer && cropEditing?.kind === selected.kind && cropEditing.id === selected.id);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} style={fullscreen ? { padding: 0 } : undefined}>
      <div
        className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()}
        style={fullscreen
          ? { maxWidth: 'none', width: '100vw', height: '100vh', padding: 0, borderRadius: 0, display: 'flex', flexDirection: 'column', position: 'relative' }
          : { maxWidth: 900, position: 'relative' }}
      >
        {fullscreen ? (
          // The title bar is dropped entirely in fullscreen so the picture
          // can span the full viewport height (see FULLSCREEN_V_RESERVE) -
          // just the two controls remain, floating over the top-right corner
          // of the picture instead of taking their own layout row.
          <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 30, display: 'flex', gap: 6 }}>
            <button
              className="icon-btn" style={{ width: 30, height: 30, background: 'rgba(20,20,20,0.75)' }} onClick={() => setFullscreen(false)}
              title={L.poster_collapseFullscreen}
            >
              <Minimize2 size={15} />
            </button>
            <button className="icon-btn" style={{ width: 30, height: 30, background: 'rgba(20,20,20,0.75)' }} onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        ) : (
          <div className="modal-header">
            <span>{L.poster_constructorTitle}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setFullscreen(true)}
                title={L.poster_expandFullscreen}
              >
                <Maximize2 size={15} />
              </button>
              <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
                <X size={15} />
              </button>
            </div>
          </div>
        )}

        <div style={fullscreen ? { display: 'flex', gap: 16, flex: 1, minHeight: 0, padding: '0 14px 14px' } : { display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {fullscreen ? (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {pictureBox}
            </div>
          ) : pictureBox}

          <div style={panelStyle}>
            {bg.image && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={undo} disabled={past.length === 0} title={L.poster_undo}>
                  <Undo2 size={13} />
                </button>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={redo} disabled={future.length === 0} title={L.poster_redo}>
                  <Redo2 size={13} />
                </button>
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.15)' }} />
                <span className="scene-prompt-label" style={{ flex: 1 }}>{L.poster_zoomLabel}</span>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => zoomButton(1 / ZOOM_STEP)} title={L.poster_zoomOut}>
                  <Minus size={13} />
                </button>
                <button className="icon-btn" style={{ width: 44, height: 26, fontSize: 10.5 }} onClick={resetZoom} title={L.poster_zoomReset}>
                  {Math.round(zoom * 100)}%
                </button>
                <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={() => zoomButton(ZOOM_STEP)} title={L.poster_zoomIn}>
                  <Plus size={13} />
                </button>
              </div>
            )}

            <PickerRow label={L.poster_backgroundLabel} scrollable collapsible>
              {candidates.map((path) => (
                <PickerThumb key={path} selected={backgroundPath === path} onClick={() => pickBackground(path)}>
                  <img src={mediaUrl(`projects/${projectId}/${path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_titleCardLabel} collapsible>
              {variants.map((v) => (
                <PickerThumb key={v.variant_id} selected={titleCardVariantId === v.variant_id} onClick={() => pickTitleCard(v.variant_id)}>
                  <img src={mediaUrl(`projects/${projectId}/${v.file_path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_logoLabel} collapsible defaultOpen={false}>
              <PickerThumb selected={!logoId} onClick={() => pickLogo(null)}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 10.5, color: 'var(--text-dim)' }}>
                  {L.poster_noLogo}
                </span>
              </PickerThumb>
              {logos.map((l) => (
                <PickerThumb key={l.id} selected={logoId === l.id} onClick={() => pickLogo(l.id)} title={l.name}>
                  <img src={mediaUrl(l.file_path)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_objectsLabel} collapsible defaultOpen={false}>
              {glassLayer ? (
                <PickerThumb selected={selected?.kind === 'glass'} onClick={() => setSelected({ kind: 'glass' })} title={L.poster_glassLabel}>
                  <div style={{ width: '100%', height: '100%', borderRadius: 5, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.5)' }} />
                </PickerThumb>
              ) : (
                <button className="btn" style={{ fontSize: 12, padding: '6px 10px', gap: 6 }} onClick={addGlass} disabled={!bg.width}>
                  <Square size={13} />
                  {L.poster_addGlass}
                </button>
              )}
              {textLayers.map((layer) => (
                <PickerThumb
                  key={layer.id} selected={selected?.kind === 'text' && selected.id === layer.id}
                  onClick={() => setSelected({ kind: 'text', id: layer.id })} title={layer.text}
                >
                  <span
                    style={{
                      fontFamily: layer.fontFamily, fontSize: 15, color: '#fff', fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
                      background: layer.textType === 'badge' ? '#000' : 'transparent', borderRadius: 5,
                      textShadow: layer.textType === 'halo' ? '0 0 4px rgba(0,0,0,0.6)' : 'none',
                    }}
                  >
                    Aa
                  </span>
                </PickerThumb>
              ))}
              <button className="btn" style={{ fontSize: 12, padding: '6px 10px', gap: 6 }} onClick={() => addTextLayer('badge')} disabled={!bg.width}>
                <Type size={13} />
                {L.poster_addTextBadge}
              </button>
              <button className="btn" style={{ fontSize: 12, padding: '6px 10px', gap: 6 }} onClick={() => addTextLayer('halo')} disabled={!bg.width}>
                <Type size={13} />
                {L.poster_addTextHalo}
              </button>
            </PickerRow>

            <PickerRow label={L.poster_templatesLabel} collapsible defaultOpen={false}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                {posterTemplates.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {posterTemplates.map((t) => (
                      <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <button className="chip" onClick={() => applyTemplate(t.id)} title={L.poster_applyTemplate}>{t.name}</button>
                        <button
                          className="icon-btn" style={{ width: 20, height: 20 }}
                          title={L.poster_deleteTemplate}
                          onClick={() => onDeleteTemplate?.(t.id)}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="field" style={{ flex: 1, fontSize: 12 }}
                    value={templateNameDraft}
                    onChange={(e) => setTemplateNameDraft(e.target.value)}
                    placeholder={L.poster_templateNamePlaceholder}
                  />
                  <button
                    className="btn btn-accent-soft" style={{ fontSize: 11.5, padding: '5px 9px', gap: 5, flexShrink: 0 }}
                    onClick={saveCurrentAsTemplate} disabled={!templateNameDraft.trim()}
                  >
                    <Save size={12} />
                    {L.poster_saveTemplate}
                  </button>
                </div>
              </div>
            </PickerRow>

            <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{L.poster_dragHint}</div>

            {selected?.kind === 'glass' && glassLayer && (
              <GlassPanel glass={glassLayer} onChange={(next) => commit(() => setGlassLayer(next))} onRemove={removeGlass} L={L} />
            )}

            {selectedLayer && (
              <>
                <LayerToolbar
                  layer={selectedLayer}
                  siblingCount={layerListFor(selected.kind)[0].length}
                  isCropEditing={isEditingSelectedCrop}
                  allowCrop={selected.kind !== 'text'}
                  onDuplicate={() => duplicateLayer(selected.kind, selected.id)}
                  onDelete={() => deleteLayer(selected.kind, selected.id)}
                  onToggleCrop={() => setCropEditing(isEditingSelectedCrop ? null : { kind: selected.kind, id: selected.id })}
                  onResetCrop={() => updateLayer(selected.kind, selected.id, { crop: null })}
                  L={L}
                />
                {selected.kind === 'text' && (
                  <TextLayerPanel
                    layer={selectedLayer}
                    onChange={(patch) => updateLayer('text', selected.id, patch)}
                    L={L}
                  />
                )}
                {!isEditingSelectedCrop && (
                  <EffectsPanel
                    label={selected.kind === 'title'
                      ? L.poster_titleCardLabel
                      : selected.kind === 'logo'
                        ? L.poster_logoLabel
                        : (selectedLayer.textType === 'badge' ? L.poster_textBadgeLabel : L.poster_textHaloLabel)}
                    effects={selectedLayer.effects}
                    onChange={(next) => updateLayer(selected.kind, selected.id, { effects: next })}
                    L={L}
                  />
                )}
              </>
            )}

            <button
              className="btn btn-gradient" style={{ justifyContent: 'center', padding: 11, marginTop: 'auto' }}
              disabled={saving || !backgroundPath || !titleCardVariantId}
              onClick={handleSave}
            >
              <Save size={14} />
              {saving ? L.poster_saving : L.poster_save}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

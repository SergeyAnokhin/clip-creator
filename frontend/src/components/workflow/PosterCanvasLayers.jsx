import { useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Group, Image as KonvaImage, Rect, Text, Transformer } from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { glowPasses, snapGroupToCenter } from '../../lib/posterLayers.js';
import { pctTransformToPixels, pixelsToPctTransform } from '../../lib/canvasLayer.js';
import CanvasLayer from '../shared/CanvasLayer.jsx';

/** The draggable overlay node types the Poster constructor's Konva stage
 * renders: an image layer (title card or logo), a magic layer, the
 * frosted-glass panel, and a text layer. Each owns its own
 * drag/Transformer/snap wiring and reports changes up through `onChange`;
 * none of them holds poster state - see `PosterConstructor.jsx`.
 */

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
export function OverlayImage({
  image, layer, isSelected, isCropEditing, onSelect, onChange, onCropChange,
  bgWidth, bgHeight, effectiveScale, setGuides,
}) {
  const cropRectRef = useRef(null);
  const cropTrRef = useRef(null);
  const cloneRef = useRef(null);

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

  // The layer's stored pixel transform (bg-natural-pixel space) converted to
  // percentages of the background box purely at this boundary - CanvasLayer
  // itself only ever sees/reports percentages (see lib/canvasLayer.js's
  // module docstring for why).
  const pct = pixelsToPctTransform(
    { x: layer.x, y: layer.y, scaleX: layer.scaleX, scaleY: layer.scaleY, rotation: layer.rotation },
    bgWidth, bgHeight, boxW, boxH,
  );

  return (
    <CanvasLayer
      xPct={pct.xPct} yPct={pct.yPct} widthPct={pct.widthPct} heightPct={pct.heightPct} rotationDeg={pct.rotationDeg}
      naturalW={boxW} naturalH={boxH} containerW={bgWidth} containerH={bgHeight}
      isSelected={isSelected && !isCropEditing}
      draggable={!isCropEditing}
      onSelect={onSelect}
      onDragMove={(e) => setGuides(snapGroupToCenter(e.target, bgWidth, bgHeight, effectiveScale))}
      onChange={(next) => {
        setGuides({ v: false, h: false });
        const px = pctTransformToPixels(next, bgWidth, bgHeight, boxW, boxH);
        onChange({ x: px.x, y: px.y, scaleX: px.scaleX, scaleY: px.scaleY, rotation: px.rotation });
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
    </CanvasLayer>
  );
}

/** One magic layer (see `makeMagicLayer` / providers/magic_layers.py). Exists
 * as its own component purely so each layer can call `useHtmlImage` for its
 * own file: the constructor loads its three fixed slots (background, title
 * card, logo) with three top-level hook calls, and a decomposition
 * contributes N images at once, which hooks can't be called in a loop for.
 * Everything past image loading is the ordinary `OverlayImage`, so magic
 * layers get drag/transform/crop/effects for free. */
export function MagicLayerNode({ projectId, layer, ...rest }) {
  // Same `?canvas` cache-key separator as PosterConstructor's slots - see the
  // comment there for the cross-origin race it works around.
  const img = useHtmlImage(layer?.src?.file_path
    ? `${mediaUrl(`projects/${projectId}/${layer.src.file_path}`)}?canvas`
    : null);
  return <OverlayImage image={img.image} layer={layer} {...rest} />;
}

/** A draggable+resizable "frosted glass" panel object - a plain rounded
 * rect, not tied to any source image. Cheap live-preview look only (white
 * tint + soft edge highlight); the real blurred-background version is
 * baked in at save time (see handleSave's glassNode substitution), since a
 * true backdrop blur redrawn on every drag frame would be too slow. Found
 * at save time via its Konva `name` ('glass-group') rather than a ref, to
 * avoid extra ref plumbing between this component and PosterConstructor. */
export function OverlayGlass({ transform, isSelected, onSelect, onChange, bgWidth, bgHeight, effectiveScale, setGuides }) {
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
 * `Text` node's rendered size once the font is actually loaded - so its
 * size is measured via a detached probe `Text` node after each
 * paint-affecting prop change, plus once more when `document.fonts.ready`
 * resolves (in case this render raced the Google Fonts `<link>`). */
export function OverlayText({ layer, isSelected, onSelect, onChange, bgWidth, bgHeight, effectiveScale, setGuides }) {
  const groupRef = useRef(null);
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
      // Measured on a detached, unconstrained probe node rather than the
      // real (rendered) Text below - that one is fed `width={box.w}` so
      // `align` works, but Konva's `wrap="none"` doesn't actually skip its
      // width-constrained line-splitting, so once `box.w` starts small
      // (initial state) the real node keeps chopping the text into narrow
      // fragments and re-measuring it (via getTextWidth/height) would just
      // echo that same too-small size back forever - text stays invisible.
      // A fresh node with no `width` set is never subject to that split.
      const probe = new Konva.Text({ text: layer.text, fontFamily: layer.fontFamily, fontSize: layer.fontSize, wrap: 'none' });
      setBox({ w: probe.getTextWidth(), h: probe.height() });
      probe.destroy();
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

/** Small inline reset control shown next to a slider/color's current value
 * once it has drifted from `defaultValue` - lets the user snap a single
 * effect knob back to its neutral value without hunting for a top-level
 * "reset all" action. Rendered only when `defaultValue` is passed in, so
 * callers that don't have a meaningful neutral value (e.g. clone offsets)
 * simply omit it and get no button. */

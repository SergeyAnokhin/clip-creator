import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Image as KonvaImage, Layer, Rect, Stage, Transformer } from 'react-konva';
import { Crop, Loader2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { mediaUrl } from '../../api/client.js';
import { onBackdropClick } from '../../lib/a11y.js';

const OUTPAINT_MAX_CANVAS_SIDE = 2560;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
// Generous per-side clamp for the Transformer's live drag/resize (kept
// simple - a few multiples of the natural size is plenty of room to reach
// the real 2560px cap from any reasonable starting image size). The exact
// shared left+right / top+bottom budget check (matching the backend's) runs
// separately below to drive the live indicator and disable Save.
const DRAG_CLAMP_MULTIPLE = 4;

/** Fullscreen crop/outpaint editor for one scene-generated image
 * (`ImageCarousel.jsx`'s new crop button, scene images only). A draggable/
 * resizable rectangle over the image, in the image's own natural-pixel
 * coordinates - same convention as `PosterConstructor.jsx`'s crop mode,
 * whose `Rect`+`Transformer` (resize-only anchors) mechanics this copies.
 * Unlike that one, the rect here is allowed to go negative / past the far
 * edge: any such overflow becomes an outpaint request on save (see
 * `providers/images.py`'s `crop_image`) instead of just clipping. Zoom only
 * scales the Konva `Stage` (view only, same trick `PosterConstructor.jsx`'s
 * own wheel-zoom uses) - the rect's coordinates never change with zoom, only
 * how much empty space is visible around the image to drag it into. */
export default function ImageCropEditor({ L, projectId, image, defaultQuality, onSave, onClose }) {
  const containerRef = useRef(null);
  const rectRef = useRef(null);
  const trRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState(null);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [quality, setQuality] = useState(defaultQuality === 'quality' ? 'quality' : 'fast');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const url = image ? `${mediaUrl(`projects/${projectId}/${image.file_path}`)}?crop` : null;
  const { image: htmlImage, width: naturalW, height: naturalH, loaded } = useHtmlImage(url);

  useEffect(() => {
    if (loaded) setBox({ x: 0, y: 0, width: naturalW, height: naturalH });
  }, [loaded, naturalW, naturalH]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    // Read the size synchronously on mount (ResizeObserver's first callback
    // isn't guaranteed to land in the same frame the modal opens in), then
    // keep it live for actual resizes (e.g. window resize while the editor
    // is open).
    const rect = el.getBoundingClientRect();
    setContainerSize({ w: rect.width, h: rect.height });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (trRef.current && rectRef.current) {
      trRef.current.nodes([rectRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [box, loaded]);

  if (!image) return null;

  const baseScale = naturalW && containerSize.w
    ? Math.min(1, containerSize.w / naturalW, containerSize.h / naturalH)
    : 1;
  const stageScale = baseScale * zoomFactor;
  const stageX = containerSize.w / 2 - (naturalW * stageScale) / 2;
  const stageY = containerSize.h / 2 - (naturalH * stageScale) / 2;

  const overLeft = box ? Math.max(0, -box.x) : 0;
  const overTop = box ? Math.max(0, -box.y) : 0;
  const overRight = box ? Math.max(0, box.x + box.width - naturalW) : 0;
  const overBottom = box ? Math.max(0, box.y + box.height - naturalH) : 0;
  const hasOverflow = overLeft > 0 || overTop > 0 || overRight > 0 || overBottom > 0;
  const outW = naturalW + overLeft + overRight;
  const outH = naturalH + overTop + overBottom;
  const tooLarge = outW > OUTPAINT_MAX_CANVAS_SIDE || outH > OUTPAINT_MAX_CANVAS_SIDE;

  function clampDrag(node) {
    const maxOver = DRAG_CLAMP_MULTIPLE * Math.max(naturalW, naturalH, 1);
    const w = node.width();
    const h = node.height();
    const x = Math.max(-maxOver, Math.min(node.x(), naturalW + maxOver - w));
    const y = Math.max(-maxOver, Math.min(node.y(), naturalH + maxOver - h));
    node.x(x);
    node.y(y);
  }

  function zoomBy(factor) {
    setZoomFactor((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
  }

  async function handleSave() {
    if (!box || tooLarge || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(
        { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
        quality,
      );
      onClose();
    } catch (err) {
      setError(err?.detail || err?.message || L.imageCrop_saveError);
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={saving ? undefined : onBackdropClick(onClose)}>
      <div className="modal-card modal-card-lg crop-editor-card">
        <div className="modal-header">
          <span className="crop-editor-title"><Crop size={15} /> {L.imageCrop_title}</span>
          <div className="crop-editor-zoom">
            <button className="icon-btn" onClick={() => zoomBy(1 / ZOOM_STEP)} title={L.imageCrop_zoomOut}>
              <ZoomOut size={14} />
            </button>
            <span>{Math.round(zoomFactor * 100)}%</span>
            <button className="icon-btn" onClick={() => zoomBy(ZOOM_STEP)} title={L.imageCrop_zoomIn}>
              <ZoomIn size={14} />
            </button>
          </div>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={saving ? undefined : onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="crop-editor-stage" ref={containerRef}>
          {loaded && box && containerSize.w > 0 && (
            <Stage
              width={containerSize.w} height={containerSize.h}
              scaleX={stageScale} scaleY={stageScale} x={stageX} y={stageY}
            >
              <Layer>
                <KonvaImage image={htmlImage} width={naturalW} height={naturalH} listening={false} />
                <Rect
                  ref={rectRef}
                  x={box.x} y={box.y} width={box.width} height={box.height}
                  stroke={tooLarge ? '#ef4444' : (hasOverflow ? '#ff9d5c' : '#fff')}
                  strokeWidth={2 / stageScale}
                  dash={hasOverflow ? [8 / stageScale, 6 / stageScale] : undefined}
                  fill="rgba(255,157,92,0.12)"
                  draggable
                  onDragMove={(e) => clampDrag(e.target)}
                  onDragEnd={(e) => setBox({ x: e.target.x(), y: e.target.y(), width: e.target.width(), height: e.target.height() })}
                  onTransformEnd={() => {
                    const node = rectRef.current;
                    if (!node) return;
                    const w = Math.max(20, node.width() * node.scaleX());
                    const h = Math.max(20, node.height() * node.scaleY());
                    node.scaleX(1);
                    node.scaleY(1);
                    node.width(w);
                    node.height(h);
                    clampDrag(node);
                    setBox({ x: node.x(), y: node.y(), width: node.width(), height: node.height() });
                  }}
                />
                <Transformer
                  ref={trRef}
                  rotateEnabled={false}
                  enabledAnchors={[
                    'top-left', 'top-center', 'top-right',
                    'middle-left', 'middle-right',
                    'bottom-left', 'bottom-center', 'bottom-right',
                  ]}
                  anchorSize={10 / stageScale}
                  borderStrokeWidth={2 / stageScale}
                  boundBoxFunc={(oldBox, newBox) => (newBox.width < 20 || newBox.height < 20 ? oldBox : newBox)}
                />
              </Layer>
            </Stage>
          )}
          {!loaded && <span className="crop-editor-loading"><Loader2 size={20} className="spin" /></span>}
        </div>

        <div className="crop-editor-footer">
          <div className="crop-editor-quality">
            <button className={quality === 'fast' ? 'is-active' : ''} onClick={() => setQuality('fast')}>
              {L.imageCrop_qualityFast}
            </button>
            <button className={quality === 'quality' ? 'is-active' : ''} onClick={() => setQuality('quality')}>
              {L.imageCrop_qualityHigh}
            </button>
          </div>

          <div className={`crop-editor-indicator${tooLarge ? ' is-error' : hasOverflow ? ' is-active' : ''}`}>
            {tooLarge
              ? L.imageCrop_tooLarge.replace('{w}', outW).replace('{h}', outH).replace('{max}', OUTPAINT_MAX_CANVAS_SIDE)
              : hasOverflow
                ? L.imageCrop_willOutpaint.replace('{w}', outW).replace('{h}', outH)
                : L.imageCrop_plainCrop}
          </div>

          {error && <div className="crop-editor-error">{error}</div>}

          <div className="crop-editor-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>{L.cancel}</button>
            <button className="btn btn-gradient" onClick={handleSave} disabled={saving || tooLarge}>
              {saving ? <Loader2 size={14} className="spin" /> : null} {L.save}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

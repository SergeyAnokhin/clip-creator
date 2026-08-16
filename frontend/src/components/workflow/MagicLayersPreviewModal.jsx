import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layer, Image as KonvaImage, Stage } from 'react-konva';
import { Eye, EyeOff, RotateCcw, Sparkles, X } from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';
import { onActivateKey, onBackdropClick } from '../../lib/a11y.js';

/** One layer's image on the preview `Stage`. A thin `useHtmlImage` +
 * `KonvaImage` wrapper (same reason `MagicLayerNode` exists in
 * PosterCanvasLayers.jsx - a loop can't call a hook per iteration), but
 * deliberately not `OverlayImage`/`MagicLayerNode` themselves: this sandbox
 * only ever translates a layer, so it skips their crop/effects/Transformer
 * machinery entirely. */
function PreviewLayerImage({ projectId, layer, offset, hidden, isSelected, onSelect, onDragEnd }) {
  const { image } = useHtmlImage(layer?.file_path
    ? `${mediaUrl(`projects/${projectId}/${layer.file_path}`)}?magic-preview`
    : null);
  if (!image || hidden) return null;
  return (
    <KonvaImage
      image={image}
      x={offset.x} y={offset.y}
      draggable
      opacity={isSelected ? 1 : 0.98}
      onClick={onSelect} onTap={onSelect}
      onDragEnd={(e) => onDragEnd({ x: Math.round(e.target.x()), y: Math.round(e.target.y()) })}
    />
  );
}

/** Ephemeral "how well did this split actually work" sandbox — opened from
 * the ✨N badge next to any already-decomposed image (ImageCarousel.jsx,
 * TitleCardGallery.jsx). Unlike the poster constructor, nothing here is ever
 * saved: it exists purely so a layer can be dragged around and dropped back,
 * to see whether the model separated it cleanly (no holes, no bleed) before
 * committing to using the group on a real poster. Closing it discards every
 * offset - reopening always starts back at (0,0) for every layer. */
export default function MagicLayersPreviewModal({ L, projectId, group, onClose }) {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [offsets, setOffsets] = useState({});
  const [hiddenSet, setHiddenSet] = useState(() => new Set());
  const [selected, setSelected] = useState(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    setContainerSize({ w: rect.width, h: rect.height });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!group) return null;
  const canvasW = group.canvas?.width || 0;
  const canvasH = group.canvas?.height || 0;
  const scale = canvasW && containerSize.w
    ? Math.min(1, containerSize.w / canvasW, containerSize.h / canvasH)
    : 1;
  const stageX = containerSize.w / 2 - (canvasW * scale) / 2;
  const stageY = containerSize.h / 2 - (canvasH * scale) / 2;

  function offsetFor(index) {
    return offsets[index] || { x: 0, y: 0 };
  }

  function toggleHidden(index) {
    setHiddenSet((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  function resetLayer(index) {
    setOffsets((o) => { const next = { ...o }; delete next[index]; return next; });
  }

  function resetAll() {
    setOffsets({});
    setHiddenSet(new Set());
    setSelected(null);
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onBackdropClick(onClose)}>
      <div className="modal-card modal-card-lg magic-preview-card">
        <div className="modal-header">
          <span className="crop-editor-title"><Sparkles size={15} /> {L.magic_previewTitle}</span>
          <span className="magic-preview-subtitle">{canvasW}×{canvasH} · {group.num_layers} {L.magic_layersCount.toLowerCase()}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="magic-preview-body">
          <div className="crop-editor-stage magic-preview-stage" ref={containerRef}>
            {containerSize.w > 0 && canvasW > 0 && (
              <Stage width={containerSize.w} height={containerSize.h} scaleX={scale} scaleY={scale} x={stageX} y={stageY}>
                <Layer>
                  {group.layers.map((layer) => (
                    <PreviewLayerImage
                      key={layer.index}
                      projectId={projectId}
                      layer={layer}
                      offset={offsetFor(layer.index)}
                      hidden={hiddenSet.has(layer.index)}
                      isSelected={selected === layer.index}
                      onSelect={() => setSelected(layer.index)}
                      onDragEnd={(pos) => setOffsets((o) => ({ ...o, [layer.index]: pos }))}
                    />
                  ))}
                </Layer>
              </Stage>
            )}
          </div>

          <div className="magic-preview-sidebar">
            <div className="magic-preview-hint">{L.magic_previewHint}</div>
            {group.layers.map((layer) => {
              const off = offsetFor(layer.index);
              const hidden = hiddenSet.has(layer.index);
              const label = layer.is_background ? L.magic_backgroundLayer : `${L.magic_layer} ${layer.index}`;
              return (
                <div
                  key={layer.index}
                  className={`magic-preview-row${selected === layer.index ? ' is-selected' : ''}`}
                  role="button" tabIndex={0} aria-pressed={selected === layer.index} aria-label={label}
                  onClick={() => setSelected(layer.index)}
                  onKeyDown={onActivateKey(() => setSelected(layer.index))}
                >
                  <img
                    src={mediaUrl(`projects/${projectId}/${layer.file_path}`)}
                    alt="" className="magic-preview-thumb"
                  />
                  <div className="magic-preview-row-main">
                    <span className="magic-preview-row-label">{label}</span>
                    <span className="magic-preview-row-offset">x {off.x}, y {off.y}</span>
                  </div>
                  <button
                    className="icon-btn" style={{ width: 24, height: 24 }}
                    title={hidden ? L.magic_previewShow : L.magic_previewHide}
                    onClick={(e) => { e.stopPropagation(); toggleHidden(layer.index); }}
                  >
                    {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button
                    className="icon-btn" style={{ width: 24, height: 24 }}
                    title={L.magic_previewResetLayer}
                    disabled={!offsets[layer.index]}
                    onClick={(e) => { e.stopPropagation(); resetLayer(layer.index); }}
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="crop-editor-footer">
          <div className="crop-editor-indicator">{L.magic_previewNotSaved}</div>
          <div className="crop-editor-actions">
            <button className="btn btn-ghost" onClick={resetAll}>{L.magic_previewReset}</button>
            <button className="btn btn-gradient" onClick={onClose}>{L.magic_previewClose}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

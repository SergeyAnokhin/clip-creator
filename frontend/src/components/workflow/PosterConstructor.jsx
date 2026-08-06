import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Save, X } from 'lucide-react';
import { Image as KonvaImage, Layer, Stage, Transformer } from 'react-konva';
import { mediaUrl } from '../../api/client.js';
import { useHtmlImage } from '../../hooks/useHtmlImage.js';

const MAX_DISPLAY_W = 760;
const MAX_DISPLAY_H = 520;

/** One draggable+resizable overlay (title card text or logo) on the poster
 * canvas - a thin wrapper around Konva's own drag/Transformer handles, so
 * PosterConstructor only has to track `{x, y, scaleX, scaleY, rotation}` per
 * layer (the same shape that gets persisted, letting a saved poster be
 * re-opened with its layers exactly where they were left). */
function OverlayImage({ image, transform, isSelected, onSelect, onChange }) {
  const shapeRef = useRef(null);
  const trRef = useRef(null);

  useEffect(() => {
    if (isSelected && trRef.current && shapeRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected]);

  if (!image || !transform) return null;
  return (
    <>
      <KonvaImage
        ref={shapeRef}
        image={image}
        x={transform.x} y={transform.y}
        scaleX={transform.scaleX} scaleY={transform.scaleY}
        rotation={transform.rotation}
        draggable
        onClick={onSelect} onTap={onSelect}
        onDragEnd={(e) => onChange({ ...transform, x: e.target.x(), y: e.target.y() })}
        onTransformEnd={() => {
          const node = shapeRef.current;
          if (!node) return;
          onChange({ x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() });
        }}
      />
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

function PickerRow({ label, children }) {
  return (
    <div>
      <div className="scene-prompt-label" style={{ marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 140, overflowY: 'auto' }}>{children}</div>
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
  L, projectId, candidates, variants, logos, initialPoster, saving, onSave, onClose,
}) {
  const [backgroundPath, setBackgroundPath] = useState(initialPoster?.background_path || candidates[0] || null);
  const [titleCardVariantId, setTitleCardVariantId] = useState(initialPoster?.title_card_variant_id || variants[0]?.variant_id || null);
  const [logoId, setLogoId] = useState(initialPoster?.logo_id || null);
  const [titleLayer, setTitleLayer] = useState(initialPoster?.layers?.title_card || null);
  const [logoLayer, setLogoLayer] = useState(initialPoster?.layers?.logo || null);
  const [selected, setSelected] = useState(null);
  const stageRef = useRef(null);

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

  const scale = bg.width ? Math.min(1, MAX_DISPLAY_W / bg.width, MAX_DISPLAY_H / bg.height) : 1;
  const displayW = Math.round((bg.width || MAX_DISPLAY_W) * scale);
  const displayH = Math.round((bg.height || MAX_DISPLAY_H) * scale);

  // Default-place a freshly picked overlay (no stored transform yet) once
  // both its image and the background's natural size are known.
  useEffect(() => {
    if (titleImg.image && !titleLayer && bg.width) {
      const s = (bg.width * 0.6) / titleImg.width;
      setTitleLayer({ x: (bg.width - titleImg.width * s) / 2, y: (bg.height - titleImg.height * s) / 2, scaleX: s, scaleY: s, rotation: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleImg.image, bg.width]);

  useEffect(() => {
    if (logoImg.image && logoId && !logoLayer && bg.width) {
      const s = (bg.width * 0.18) / logoImg.width;
      setLogoLayer({ x: bg.width * 0.04, y: bg.height * 0.04, scaleX: s, scaleY: s, rotation: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoImg.image, logoId, bg.width]);

  function pickBackground(path) { setBackgroundPath(path); }
  function pickTitleCard(variantId) { setTitleCardVariantId(variantId); setTitleLayer(null); setSelected(null); }
  function pickLogo(id) { setLogoId(id); setLogoLayer(null); setSelected(null); }

  async function handleSave() {
    if (!backgroundPath || !titleCardVariantId || !bg.width || !stageRef.current) return;
    const blob = await stageRef.current.toBlob({ pixelRatio: bg.width / displayW, mimeType: 'image/png' });
    onSave({
      blob, backgroundPath, titleCardVariantId, logoId,
      canvasSize: { width: bg.width, height: bg.height },
      layers: { title_card: titleLayer, logo: logoId ? logoLayer : null },
      posterId: initialPoster?.poster_id,
    });
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900 }}>
        <div className="modal-header">
          <span>{L.poster_constructorTitle}</span>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div
            style={{
              width: displayW, height: displayH, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
              background: 'repeating-conic-gradient(#2a2a2a 0% 25%, #363636 0% 50%) 50% / 16px 16px',
            }}
          >
            {bg.image && (
              <Stage
                ref={stageRef} width={displayW} height={displayH} scaleX={scale} scaleY={scale}
                onMouseDown={(e) => { if (e.target === e.target.getStage()) setSelected(null); }}
                onTouchStart={(e) => { if (e.target === e.target.getStage()) setSelected(null); }}
              >
                <Layer>
                  <KonvaImage image={bg.image} width={bg.width} height={bg.height} listening={false} />
                  {titleImg.image && (
                    <OverlayImage
                      image={titleImg.image} transform={titleLayer} isSelected={selected === 'title'}
                      onSelect={() => setSelected('title')} onChange={setTitleLayer}
                    />
                  )}
                  {logoId && logoImg.image && (
                    <OverlayImage
                      image={logoImg.image} transform={logoLayer} isSelected={selected === 'logo'}
                      onSelect={() => setSelected('logo')} onChange={setLogoLayer}
                    />
                  )}
                </Layer>
              </Stage>
            )}
          </div>

          <div style={{ flex: '1 1 220px', minWidth: 220, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <PickerRow label={L.poster_backgroundLabel}>
              {candidates.map((path) => (
                <PickerThumb key={path} selected={backgroundPath === path} onClick={() => pickBackground(path)}>
                  <img src={mediaUrl(`projects/${projectId}/${path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_titleCardLabel}>
              {variants.map((v) => (
                <PickerThumb key={v.variant_id} selected={titleCardVariantId === v.variant_id} onClick={() => pickTitleCard(v.variant_id)}>
                  <img src={mediaUrl(`projects/${projectId}/${v.file_path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 5 }} />
                </PickerThumb>
              ))}
            </PickerRow>

            <PickerRow label={L.poster_logoLabel}>
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

            <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{L.poster_dragHint}</div>

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

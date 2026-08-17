import { useEffect, useRef } from 'react';
import { Group, Transformer } from 'react-konva';
import { pctTransformToPixels, pixelsToPctTransform } from '../../lib/canvasLayer.js';

/** The generic "one draggable+resizable+rotatable object on a Konva stage"
 * primitive - a thin wrapper around Konva's own drag/Transformer handles,
 * extracted from the Poster constructor's `OverlayImage`
 * (`components/workflow/PosterCanvasLayers.jsx`) so the Editor stage's
 * overlay canvas (`EditorPreview.jsx`) can reuse the exact same
 * drag/resize/rotate interaction instead of a second implementation.
 *
 * Knows nothing about what it's placing - crop editing, glow/clone effects,
 * magic-layer sourcing, text measurement etc. all stay in the caller
 * (`children`, rendered inside the wrapped `Group` at local `(0,0)`, exactly
 * like `OverlayImage` nests its own `KonvaImage`s today). Position/size are
 * stored and reported as *percentages* of the caller's container box (see
 * `lib/canvasLayer.js`'s module docstring for why), converted to/from
 * Konva's pixel-space `x/y/scaleX/scaleY/rotation` only at the boundary
 * here. */
export default function CanvasLayer({
  children,
  xPct, yPct, widthPct, heightPct, rotationDeg = 0,
  naturalW, naturalH, containerW, containerH,
  isSelected, draggable = true, rotatable = true,
  onSelect, onChange, onDragMove,
  minWidthPx = 10, minHeightPx = 10, name,
}) {
  const groupRef = useRef(null);
  const trRef = useRef(null);

  useEffect(() => {
    if (isSelected && trRef.current && groupRef.current) {
      trRef.current.nodes([groupRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected]);

  const { x, y, scaleX, scaleY, rotation } = pctTransformToPixels(
    { xPct, yPct, widthPct, heightPct, rotationDeg }, containerW, containerH, naturalW, naturalH,
  );

  function commitTransform(node) {
    onChange(pixelsToPctTransform(
      { x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() },
      containerW, containerH, naturalW, naturalH,
    ));
  }

  return (
    <>
      <Group
        ref={groupRef}
        name={name}
        x={x} y={y} scaleX={scaleX} scaleY={scaleY} rotation={rotation}
        draggable={draggable}
        onClick={onSelect} onTap={onSelect}
        onDragMove={onDragMove}
        onDragEnd={(e) => commitTransform(e.target)}
        onTransformEnd={() => { if (groupRef.current) commitTransform(groupRef.current); }}
      >
        {children}
      </Group>
      {isSelected && (
        <Transformer
          ref={trRef}
          rotateEnabled={rotatable}
          enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
          boundBoxFunc={(oldBox, newBox) => (newBox.width < minWidthPx || newBox.height < minHeightPx ? oldBox : newBox)}
        />
      )}
    </>
  );
}

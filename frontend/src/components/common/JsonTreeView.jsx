import { useState } from 'react';

/** How deep a node starts *expanded* - beyond this, nodes render collapsed
 * (VSCode-style `{n}`/`[n]` summary) so a large raw payload (e.g. Mureka's
 * `lyrics_sections` with per-word timing) doesn't dump hundreds of rows on
 * first render. Any node stays individually toggleable regardless of depth. */
const AUTO_EXPAND_DEPTH = 2;

function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

function scalarClassName(value) {
  if (value === null) return 'json-tree-null';
  switch (typeof value) {
    case 'string': return 'json-tree-string';
    case 'number': return 'json-tree-number';
    case 'boolean': return 'json-tree-boolean';
    default: return '';
  }
}

function JsonNode({ keyLabel, value, depth }) {
  const isArray = Array.isArray(value);
  const isContainer = isArray || (value !== null && typeof value === 'object');
  const [collapsed, setCollapsed] = useState(depth >= AUTO_EXPAND_DEPTH);

  if (!isContainer) {
    return (
      <div className="json-tree-row">
        {keyLabel != null && <><span className="json-tree-key">{keyLabel}</span><span className="json-tree-punct">: </span></>}
        <span className={scalarClassName(value)}>{formatScalar(value)}</span>
      </div>
    );
  }

  const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
  const isEmpty = entries.length === 0;
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];

  return (
    <div className="json-tree-node">
      <div className={`json-tree-row${isEmpty ? '' : ' json-tree-toggle'}`} onClick={() => !isEmpty && setCollapsed((c) => !c)}>
        {!isEmpty && <span className="json-tree-arrow">{collapsed ? '▶' : '▼'}</span>}
        {keyLabel != null && <><span className="json-tree-key">{keyLabel}</span><span className="json-tree-punct">: </span></>}
        <span className="json-tree-punct">{open}</span>
        {(isEmpty || collapsed) && (
          <>
            {!isEmpty && <span className="json-tree-summary">{entries.length}</span>}
            <span className="json-tree-punct">{close}</span>
          </>
        )}
      </div>
      {!isEmpty && !collapsed && (
        <div className="json-tree-children">
          {entries.map(([k, v]) => (
            <JsonNode key={k} keyLabel={isArray ? String(k) : `"${k}"`} value={v} depth={depth + 1} />
          ))}
          <div className="json-tree-row"><span className="json-tree-punct">{close}</span></div>
        </div>
      )}
    </div>
  );
}

/** Collapsible, colorized JSON viewer in the style of a code editor's tree
 * view - built in-house rather than pulling in a dependency, since it only
 * needs to render already-parsed data (no editing, no huge virtualized
 * trees). Used for Mureka's `track.raw` (MurekaStage.jsx's details panel,
 * MurekaTrackDetailModal.jsx) but not Mureka-specific itself. */
export default function JsonTreeView({ data }) {
  return (
    <div className="json-tree">
      <JsonNode keyLabel={null} value={data} depth={0} />
    </div>
  );
}

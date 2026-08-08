import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsDown, ChevronsUp, Copy } from 'lucide-react';

/** How deep a node starts *expanded* - beyond this, nodes render collapsed
 * (VSCode-style `{n}`/`[n]` summary) so a large raw payload (e.g. Mureka's
 * `lyrics_sections` with per-word timing) doesn't dump hundreds of rows on
 * first render. Any node stays individually toggleable regardless of depth.
 * "Expand all" (the toolbar button below) overrides this per-node default
 * rather than raising it, since a payload can nest deeper than any fixed
 * default would want to auto-open. */
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

function JsonNode({ keyLabel, value, depth, forceEpoch }) {
  const isArray = Array.isArray(value);
  const isContainer = isArray || (value !== null && typeof value === 'object');
  const [collapsed, setCollapsed] = useState(depth >= AUTO_EXPAND_DEPTH);
  const lastEpoch = useRef(null);

  // "Expand all"/"collapse all" bump `forceEpoch.epoch` - every node (any
  // depth) applies `forceEpoch.collapsed` once per epoch, then goes back to
  // being individually toggleable until the next bump. A ref instead of a
  // `useState` default avoids re-applying the same epoch on every re-render
  // triggered by a sibling's click.
  useEffect(() => {
    if (!forceEpoch || forceEpoch.epoch === lastEpoch.current) return;
    lastEpoch.current = forceEpoch.epoch;
    setCollapsed(forceEpoch.collapsed);
  }, [forceEpoch]);

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
            <JsonNode key={k} keyLabel={isArray ? String(k) : `"${k}"`} value={v} depth={depth + 1} forceEpoch={forceEpoch} />
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
 * MurekaTrackDetailModal.jsx) but not Mureka-specific itself.
 *
 * The expand-all/collapse-all buttons don't hold expand state themselves -
 * each `JsonNode` still owns its own `collapsed` state (so a single node
 * stays individually toggleable afterwards), they just broadcast a one-shot
 * `{epoch, collapsed}` signal every node applies once. Copy grabs the exact
 * `data` this tree renders, pretty-printed - not the page's serialization of
 * it - so it matches what's on screen. */
export default function JsonTreeView({ L, data }) {
  const [forceEpoch, setForceEpoch] = useState(null);
  const [copied, setCopied] = useState(false);
  const epochRef = useRef(0);

  function broadcast(collapsed) {
    epochRef.current += 1;
    setForceEpoch({ epoch: epochRef.current, collapsed });
  }

  function handleCopy() {
    navigator.clipboard?.writeText(JSON.stringify(data, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <div>
      <div className="json-tree-toolbar">
        <button type="button" className="json-tree-toolbar-btn" title={L?.jsonTreeExpandAll} onClick={() => broadcast(false)}>
          <ChevronsDown size={12} />
        </button>
        <button type="button" className="json-tree-toolbar-btn" title={L?.jsonTreeCollapseAll} onClick={() => broadcast(true)}>
          <ChevronsUp size={12} />
        </button>
        <button type="button" className="json-tree-toolbar-btn" title={L?.copyButtonTitle} onClick={handleCopy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <div className="json-tree">
        <JsonNode keyLabel={null} value={data} depth={0} forceEpoch={forceEpoch} />
      </div>
    </div>
  );
}

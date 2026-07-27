import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react';

export default function TagMenu({ L, tags, onInsert }) {
  return (
    <div className="type-menu tag-menu">
      {tags.map((tag, i) => (
        <div key={i} className="type-menu-item tag-menu-row">
          <span>{tag}</span>
          <span style={{ display: 'flex', gap: 4 }}>
            <button type="button" className="line-icon-btn" title={L.insertBefore} onClick={() => onInsert(tag, 'before')}>
              <ArrowUpToLine size={12} />
            </button>
            <button type="button" className="line-icon-btn" title={L.insertAfter} onClick={() => onInsert(tag, 'after')}>
              <ArrowDownToLine size={12} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

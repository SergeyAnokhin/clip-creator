import { TYPE_COLORS, TYPE_ORDER } from '../../i18n/dict.js';
import { onActivateKey } from '../../lib/a11y.js';

export default function TypeMenu({ L, onSelect }) {
  return (
    <div className="type-menu">
      {TYPE_ORDER.map((type) => (
        <div
          key={type}
          className="type-menu-item"
          style={{ color: TYPE_COLORS[type] }}
          role="button" tabIndex={0}
          onClick={() => onSelect(type)}
          onKeyDown={onActivateKey(() => onSelect(type))}
        >
          {L[`type_${type}`]}
        </div>
      ))}
    </div>
  );
}

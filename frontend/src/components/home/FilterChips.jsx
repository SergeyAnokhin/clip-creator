const FILTERS = [
  { key: 'all', labelKey: 'filter_all' },
  { key: 'suno', labelKey: 'filter_suno' },
  { key: 'scenes', labelKey: 'filter_scenes' },
];

export default function FilterChips({ L, value, onChange }) {
  return (
    <>
      {FILTERS.map((f) => (
        <button
          key={f.key}
          className={`chip${value === f.key ? ' is-active' : ''}`}
          onClick={() => onChange(f.key)}
        >
          {L[f.labelKey]}
        </button>
      ))}
    </>
  );
}

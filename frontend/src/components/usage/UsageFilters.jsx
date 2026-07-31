const TASKS = ['suno_generate', 'wish_title', 'scene_storyboard', 'scene_image'];
const PROVIDERS = ['google', 'openrouter', 'deepseek', 'replicate', 'fal', 'krea'];
const STATUSES = ['ok', 'error'];

export default function UsageFilters({ L, filters, onChange, onReset }) {
  return (
    <div className="settings-panel" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <input
        className="field" style={{ width: 170, flex: '0 0 auto' }} value={filters.project_id}
        onChange={(e) => onChange('project_id', e.target.value)} placeholder={L.usage_filter_project}
      />
      <select className="field" style={{ width: 'auto', flex: '0 0 auto' }} value={filters.task} onChange={(e) => onChange('task', e.target.value)}>
        <option value="">{L.usage_filter_task}</option>
        {TASKS.map((t) => <option key={t} value={t}>{L[`task_${t}`]}</option>)}
      </select>
      <select className="field" style={{ width: 'auto', flex: '0 0 auto' }} value={filters.provider} onChange={(e) => onChange('provider', e.target.value)}>
        <option value="">{L.usage_filter_provider}</option>
        {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <input
        className="field" style={{ width: 170, flex: '0 0 auto' }} value={filters.model}
        onChange={(e) => onChange('model', e.target.value)} placeholder={L.usage_filter_model}
      />
      <select className="field" style={{ width: 'auto', flex: '0 0 auto' }} value={filters.status} onChange={(e) => onChange('status', e.target.value)}>
        <option value="">{L.usage_filter_status}</option>
        {STATUSES.map((s) => <option key={s} value={s}>{L[`usage_status_${s}`]}</option>)}
      </select>
      <input
        className="field" type="date" style={{ width: 145, flex: '0 0 auto' }} value={filters.date_from}
        onChange={(e) => onChange('date_from', e.target.value)} title={L.usage_filter_from}
      />
      <input
        className="field" type="date" style={{ width: 145, flex: '0 0 auto' }} value={filters.date_to}
        onChange={(e) => onChange('date_to', e.target.value)} title={L.usage_filter_to}
      />
      <button className="btn btn-accent-soft" onClick={onReset}>{L.usage_filter_reset}</button>
    </div>
  );
}

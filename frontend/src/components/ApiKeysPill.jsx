import { KeyRound } from 'lucide-react';

/** Replaces a hardcoded green "API connected" badge that was a literal, not a
 * check: it read "connected" on a fresh install with no keys at all, and the
 * first paid generation was where the user found out otherwise. This one
 * counts the keys that are actually filled in and links to where to fix it. */
export default function ApiKeysPill({ L, apiKeys, onOpenSettings }) {
  const filled = Object.values(apiKeys || {}).filter((v) => (v || '').trim()).length;
  const ok = filled > 0;
  return (
    <button
      className={`pill ${ok ? 'pill-success' : 'pill-running'}`}
      style={{ cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
      onClick={onOpenSettings}
      title={ok ? L.apiKeysConfiguredTitle : L.apiKeysMissingTitle}
    >
      <KeyRound size={12} />
      {ok ? `${L.apiKeysConfigured}: ${filled}` : L.apiKeysMissing}
    </button>
  );
}

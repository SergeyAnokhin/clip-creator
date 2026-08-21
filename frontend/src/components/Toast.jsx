import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

const LEVEL_ICON = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };

/** The toast stack. `error`/`warning` entries carry no auto-dismiss timer (see
 * `useToast`), so every toast gets an explicit close button. */
export default function Toast({ toasts, onDismiss }) {
  if (!toasts || toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = LEVEL_ICON[t.level] || Info;
        return (
          <div key={t.id} className={`toast toast-${t.level || 'info'}`}>
            <Icon size={15} className="toast-icon" />
            <span className="toast-text">{t.message}</span>
            <button type="button" className="toast-close" onClick={() => onDismiss(t.id)} title="OK" aria-label="OK">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Small "copy to clipboard" affordance dropped next to a prompt label
 * (static/motion prompt, in either SceneTextCard.jsx or SceneCard.jsx) -
 * mirrors TranslateButton.jsx's self-contained style, just flashes a
 * checkmark for a moment instead of opening a modal. */
export default function CopyButton({ L, text }) {
  const [copied, setCopied] = useState(false);
  if (!text?.trim()) return null;

  function handleCopy() {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  return (
    <button type="button" className="scene-translate-btn" title={L.copyButtonTitle} onClick={handleCopy}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

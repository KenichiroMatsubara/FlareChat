import { RefreshCw } from 'lucide-react';

import { operationLabel } from './pending';

/**
 * The screen-level answer to "is anything happening?". A control reports its own
 * work in place, but that report can be scrolled out of view or below the fold,
 * so the running operations are also named once in the middle of the screen.
 */
export const PendingOverlay = ({ running }: { running: readonly string[] }) => {
  const [first, ...rest] = running;
  if (!first) return null;
  return <div className="pending-overlay" role="status" aria-live="polite">
    <div className="pending-overlay-card">
      <RefreshCw className="spin" size={22} />
      <strong>{operationLabel(first)}</strong>
      {rest.length > 0 && <small>ほか{rest.length}件の処理を実行中です</small>}
      <small>完了するまでこのページを開いたままにしてください。</small>
    </div>
  </div>;
};

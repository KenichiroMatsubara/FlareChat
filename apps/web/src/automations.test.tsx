import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AutomationRunList } from './automations';
import type { AutomationRunView } from './api';

const run = (overrides: Partial<AutomationRunView>): AutomationRunView => ({
  id: 'run-1',
  startedAt: '2026-08-18T09:00:00.000Z',
  finishedAt: '2026-08-18T09:00:12.000Z',
  status: 'completed',
  output: '未回答は2名でした。',
  error: null,
  toolCalls: 3,
  ...overrides,
});

describe('Automation run history', () => {
  it('shows what a completed run reported', () => {
    const markup = renderToStaticMarkup(<AutomationRunList runs={[run({})]} />);

    expect(markup).toContain('未回答は2名でした。');
    expect(markup).toContain('ツール 3 回');
  });

  it('shows why a run failed rather than hiding it', () => {
    const markup = renderToStaticMarkup(
      <AutomationRunList runs={[run({ status: 'failed', output: null, error: 'model unavailable' })]} />,
    );

    expect(markup).toContain('model unavailable');
    expect(markup).toContain('automation-run-failed');
  });

  it('says nothing has run yet rather than rendering an empty list', () => {
    expect(renderToStaticMarkup(<AutomationRunList runs={[]} />)).toContain('まだ実行されていません。');
  });
});

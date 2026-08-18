import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatTranscript } from './chat';
import type { ChatTurnView } from './api';

const turn = (overrides: Partial<ChatTurnView>): ChatTurnView => ({
  id: 'turn-1',
  position: 1,
  request: '来週の予定は?',
  response: '2件です。',
  status: 'completed',
  error: null,
  ruleRunId: 'run-1',
  ...overrides,
});

describe('Operator Chat transcript', () => {
  it('shows both sides of a completed exchange', () => {
    const markup = renderToStaticMarkup(<ChatTranscript turns={[turn({})]} unreachable={[]} error="" />);

    expect(markup).toContain('来週の予定は?');
    expect(markup).toContain('2件です。');
  });

  it('keeps the question visible when the exchange failed', () => {
    const markup = renderToStaticMarkup(
      <ChatTranscript turns={[turn({ status: 'failed', response: null, error: 'model unavailable' })]} unreachable={[]} error="" />,
    );

    expect(markup).toContain('来週の予定は?');
    expect(markup).toContain('model unavailable');
  });

  it('says which server it could not reach rather than presenting the answer as complete', () => {
    const markup = renderToStaticMarkup(
      <ChatTranscript turns={[turn({})]} unreachable={[{ server: 'notion', error: 'HTTP 502' }]} error="" />,
    );

    expect(markup).toContain('notion');
    expect(markup).toContain('到達できなかった MCP Server');
  });

  it('reports an empty conversation rather than rendering nothing', () => {
    expect(renderToStaticMarkup(<ChatTranscript turns={[]} unreachable={[]} error="" />))
      .toContain('まだやり取りがありません。');
  });
});

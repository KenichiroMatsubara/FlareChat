import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChannelTestOutcome } from './channel-test';
import type { ChannelTestDelivery } from './api';

const delivery = (overrides: Partial<ChannelTestDelivery> = {}): ChannelTestDelivery => ({
  delivered: true,
  channel: 'line',
  contactId: 'contact-1',
  destination: 'Uabc',
  externalId: 'line-request-1',
  sentAt: '2026-08-19T00:00:00.000Z',
  ...overrides,
});

describe('Channel Test outcome', () => {
  it('names the Channel, the destination and the identifier the provider returned', () => {
    const markup = renderToStaticMarkup(<ChannelTestOutcome delivery={delivery()} />);

    expect(markup).toContain('LINE');
    expect(markup).toContain('Uabc');
    expect(markup).toContain('line-request-1');
  });

  it('still says what happened when the provider returned no identifier', () => {
    const markup = renderToStaticMarkup(<ChannelTestOutcome delivery={delivery({ channel: 'discord', externalId: null })} />);

    expect(markup).toContain('Discord');
    expect(markup).not.toContain('識別子');
  });
});

import { describe, expect, it } from 'vitest';

import { redirectRequest } from './index';

describe('legacy chat Worker redirect', () => {
  it('preserves the path and query while moving traffic to the canonical FlareChat Worker', () => {
    const response = redirectRequest(
      new Request('https://chat.pinara.workers.dev/organizations/org-1/automation?from=bookmark'),
      'https://flarechat.pinara.workers.dev',
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      'https://flarechat.pinara.workers.dev/organizations/org-1/automation?from=bookmark',
    );
  });
});

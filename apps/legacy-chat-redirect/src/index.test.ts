import { describe, expect, it, vi } from 'vitest';

import { redirectRequest } from './index';

describe('legacy chat Worker redirect', () => {
  it('preserves the path and query while moving traffic to the canonical FlareChat Worker', async () => {
    const response = await redirectRequest(
      new Request('https://chat.pinara.workers.dev/organizations/org-1/automation?from=bookmark'),
      'https://flarechat.pinara.workers.dev',
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      'https://flarechat.pinara.workers.dev/organizations/org-1/automation?from=bookmark',
    );
  });

  it('revokes a legacy session and clears its cookie before returning signed-out bootstrap state', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { loggedOut: true },
    }), { status: 200 }));
    const request = new Request('https://chat.pinara.workers.dev/api/bootstrap', {
      headers: {
        Cookie: 'mail_session=legacy-session',
        Origin: 'https://chat.pinara.workers.dev',
      },
    });

    const response = await redirectRequest(
      request,
      'https://flarechat.pinara.workers.dev',
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://flarechat.pinara.workers.dev/api/auth/logout'),
      {
        method: 'POST',
        headers: { Cookie: 'mail_session=legacy-session' },
      },
    );
    await expect(response.json()).resolves.toEqual({ data: { kind: 'signed_out' } });
    expect(response.headers.get('set-cookie')).toContain('mail_session=;');
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://chat.pinara.workers.dev',
    );
  });
});

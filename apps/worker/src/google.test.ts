import { describe, expect, it } from 'vitest';

import { GOOGLE_SCOPES, googleAuthorizationUrl, hasCompleteGoogleGrant, missingGoogleScopes } from './google';

describe('Automation Inbox Google grant', () => {
  it('requires the entire Automation Inbox scope set', () => {
    expect(hasCompleteGoogleGrant(GOOGLE_SCOPES)).toBe(true);
    expect(hasCompleteGoogleGrant(GOOGLE_SCOPES.filter((scope) => scope !== 'https://www.googleapis.com/auth/gmail.readonly'))).toBe(false);
    expect(missingGoogleScopes(['openid', 'email', 'profile'])).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ]);
  });

  it('accepts Google\'s canonical OpenID scope names', () => {
    expect(hasCompleteGoogleGrant([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.events.owned',
    ])).toBe(true);
  });

  it('always sends OAuth through PKCE and requests offline consent', () => {
    const url = new URL(googleAuthorizationUrl({
      clientId: 'client-id',
      redirectUri: 'https://example.com/oauth/google/callback',
      state: 'opaque-state',
      challenge: 'pkce-challenge',
    }));

    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.readonly');
  });
});

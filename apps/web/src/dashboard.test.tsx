import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GoogleReauthenticationAction, needsGoogleReauthentication } from './dashboard';

describe('Google credential recovery', () => {
  it('offers an Automation Inbox reconnection action for a revoked or expired token', () => {
    expect(needsGoogleReauthentication('Token has been expired or revoked.')).toBe(true);
    expect(renderToStaticMarkup(<GoogleReauthenticationAction onClick={() => undefined} />)).toContain('Automation Inbox を再接続する');
  });

  it('does not misclassify unrelated operation errors as credential recovery', () => {
    expect(needsGoogleReauthentication('Google Calendar が応答しませんでした。')).toBe(false);
  });
});

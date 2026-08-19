import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IssuedTokenNotice } from './access';

describe('Issued Access Token', () => {
  const issued = {
    id: 'token-1',
    name: 'cowork',
    tools: ['contacts.search', 'channel.send'],
    token: 'a-very-long-opaque-credential',
    url: 'https://flarechat.pinara.workers.dev/api/public/organizations/org-1/mcp',
  };

  it('shows the credential and the URL an outside agent needs', () => {
    const markup = renderToStaticMarkup(<IssuedTokenNotice issued={issued} />);

    expect(markup).toContain('a-very-long-opaque-credential');
    expect(markup).toContain('/api/public/organizations/org-1/mcp');
  });

  it('says the credential will not be shown again, because only its hash is kept', () => {
    expect(renderToStaticMarkup(<IssuedTokenNotice issued={issued} />)).toContain('二度と表示されません');
  });
});

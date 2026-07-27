import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SignedOutEntry } from './entry';
import { DEFAULT_MAIL_TEST_SUBJECT } from './routes';

describe('signed-out application entry', () => {
  it('presents Organization creation and existing-member login as separate choices', () => {
    const markup = renderToStaticMarkup(
      <SignedOutEntry busy={false} error="" onSelect={vi.fn()} />,
    );

    expect(markup).toContain('新しいOrganizationを作る');
    expect(markup).toContain('既存Organizationへログイン');
    expect(markup).toMatch(/class="[^"]*secondary[^"]*entry-login[^"]*"/u);
  });
});

describe('manual mailbox test defaults', () => {
  it('starts with the Nagoya Meijo RAC anniversary subject', () => {
    expect(DEFAULT_MAIL_TEST_SUBJECT).toBe('名古屋名城RAC30周年記念式典のご案内');
  });
});

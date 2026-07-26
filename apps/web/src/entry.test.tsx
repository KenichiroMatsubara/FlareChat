import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SignedOutEntry } from './app';

describe('signed-out application entry', () => {
  it('presents Organization creation and existing-member login as separate choices', () => {
    const markup = renderToStaticMarkup(
      <SignedOutEntry busy={false} error="" onSelect={vi.fn()} />,
    );

    expect(markup).toContain('新しいOrganizationを作る');
    expect(markup).toContain('既存Organizationへログイン');
  });
});

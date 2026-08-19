import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SignedOutEntry } from './entry';
import { DEFAULT_MAIL_TEST_SUBJECT, PresetSetupChoice } from './routes';

describe('signed-out application entry', () => {
  it('presents Account creation and existing-member login as separate choices', () => {
    const markup = renderToStaticMarkup(
      <SignedOutEntry busy={false} error="" onSelect={vi.fn()} />,
    );

    expect(markup).toContain('新しいAccountを作る');
    expect(markup).toContain('既存Accountへログイン');
    expect(markup).toMatch(/class="[^"]*secondary[^"]*entry-login[^"]*"/u);
  });
});

describe('manual mailbox test defaults', () => {
  it('starts with the Nagoya Meijo RAC anniversary subject', () => {
    expect(DEFAULT_MAIL_TEST_SUBJECT).toBe('名古屋名城RAC30周年記念式典のご案内');
  });
});

describe('Account setup Preset choice', () => {
  it('offers the repository Preset as an optional copy during Account creation', () => {
    const markup = renderToStaticMarkup(<PresetSetupChoice
      presets={[{ id: 'membership-organization', name: 'Membership organization', description: 'Starting configuration.' }]}
      selectedId=""
      onChange={vi.fn()}
    />);

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('Membership organization');
    expect(markup).toContain('Account作成時にコピー');
  });
});

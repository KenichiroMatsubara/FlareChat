import { describe, expect, it } from 'vitest';

import { displayRecipientIdentifier } from './privacy';

describe('Viewer privacy', () => {
  it('masks Recipient identifiers for Viewer audit access while preserving them for operators', () => {
    expect(displayRecipientIdentifier('viewer', 'guest@example.com')).toBe('***');
    expect(displayRecipientIdentifier('operator', 'guest@example.com')).toBe('guest@example.com');
  });
});

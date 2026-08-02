import { describe, expect, it } from 'vitest';

import { displayLineDestinationId, displayRecipientIdentifier } from './privacy';

describe('Viewer privacy', () => {
  it('masks Recipient identifiers for Viewer audit access while preserving them for operators', () => {
    expect(displayRecipientIdentifier('viewer', 'guest@example.com')).toBe('***');
    expect(displayRecipientIdentifier('operator', 'guest@example.com')).toBe('guest@example.com');
  });
});

describe('LINE destination privacy', () => {
  it('returns only the first five characters of a LINE destination ID', () => {
    expect(displayLineDestinationId('U1234567890')).toBe('U1234…');
    expect(displayLineDestinationId('short')).toBe('short');
  });
});

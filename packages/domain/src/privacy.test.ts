import { describe, expect, it } from 'vitest';

import { displayLineDestinationId } from './privacy';

describe('LINE destination privacy', () => {
  it('returns only the first five characters of a LINE destination ID', () => {
    expect(displayLineDestinationId('U1234567890')).toBe('U1234…');
    expect(displayLineDestinationId('short')).toBe('short');
  });
});

import { describe, expect, it } from 'vitest';

import { decodeText, fromBase64Url } from './encoding';

describe('Gmail base64url decoding', () => {
  it('accepts a padded Gmail MIME body', () => {
    expect(decodeText(fromBase64Url('44GT44KT44Gr44Gh44GvPQ=='))).toBe('こんにちは=');
  });
});

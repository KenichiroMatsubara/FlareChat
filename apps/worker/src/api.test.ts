import { describe, expect, it } from 'vitest';

import { DEFAULT_GEMINI_MODEL, generatedText } from './api';

describe('Gemini test response', () => {
  it('uses the current Flash Lite model without requiring user model input', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
  });

  it('joins text parts while ignoring non-text parts', () => {
    expect(generatedText({
      candidates: [{ content: { parts: [{ text: '東京' }, {}, { text: 'です。' }] } }],
    })).toBe('東京です。');
  });

  it('returns an empty string when Gemini has no textual candidate', () => {
    expect(generatedText({ candidates: [{ content: { parts: [{}] } }] })).toBe('');
  });
});

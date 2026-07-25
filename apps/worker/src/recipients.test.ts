import { describe, expect, it } from 'vitest';

import { exportRecipientCsv, previewRecipientCsv } from './recipients';

describe('Recipient CSV preview', () => {
  it('separates accepted recipients, duplicate addresses, and malformed rows before import', () => {
    expect(previewRecipientCsv('Alice,alice@example.com\nAgain,ALICE@example.com\nBroken\nBob,bob@example.com,extra')).toEqual({
      accepted: [{ name: 'Alice', email: 'alice@example.com' }],
      duplicates: ['alice@example.com'],
      invalid: [{ row: 3, value: 'Broken' }, { row: 4, value: 'Bob,bob@example.com,extra' }],
    });
  });
});

it('exports Recipient Profiles as name,email CSV', () => {
  expect(exportRecipientCsv([{ name: 'Alice', email: 'alice@example.com' }])).toBe('Alice,alice@example.com');
});

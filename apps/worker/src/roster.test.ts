import { describe, expect, it } from 'vitest';

import { exportContactCsv, previewContactCsv } from './roster';

describe('Contact CSV preview', () => {
  it('separates accepted Contacts, duplicate addresses, and malformed rows before import', () => {
    expect(previewContactCsv('Alice,alice@example.com\nAgain,ALICE@example.com\nBroken\nBob,bob@example.com,extra')).toEqual({
      accepted: [{ name: 'Alice', email: 'alice@example.com' }],
      duplicates: ['alice@example.com'],
      invalid: [{ row: 3, value: 'Broken' }, { row: 4, value: 'Bob,bob@example.com,extra' }],
    });
  });
});

it('exports Contacts as name,email CSV', () => {
  expect(exportContactCsv([{ name: 'Alice', email: 'alice@example.com' }])).toBe('Alice,alice@example.com');
});

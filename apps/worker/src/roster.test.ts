import { describe, expect, it } from 'vitest';

import { exportMemberCsv, previewMemberCsv } from './roster';

describe('Member CSV preview', () => {
  it('separates accepted Members, duplicate addresses, and malformed rows before import', () => {
    expect(previewMemberCsv('Alice,alice@example.com\nAgain,ALICE@example.com\nBroken\nBob,bob@example.com,extra')).toEqual({
      accepted: [{ name: 'Alice', email: 'alice@example.com' }],
      duplicates: ['alice@example.com'],
      invalid: [{ row: 3, value: 'Broken' }, { row: 4, value: 'Bob,bob@example.com,extra' }],
    });
  });
});

it('exports Members as name,email CSV', () => {
  expect(exportMemberCsv([{ name: 'Alice', email: 'alice@example.com' }])).toBe('Alice,alice@example.com');
});

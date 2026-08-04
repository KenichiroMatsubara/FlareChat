import { describe, expect, it } from 'vitest';

import { TEST_NOW } from './now';

describe('suite clock', () => {
  it('reads one fixed instant through the wall clock every module uses', () => {
    expect(new Date().toISOString()).toBe(TEST_NOW);
    expect(Date.now()).toBe(Date.parse(TEST_NOW));
  });

  it('keeps that instant across awaited work, so a slow test cannot drift past a deadline', async () => {
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(Date.now()).toBe(before);
  });
});

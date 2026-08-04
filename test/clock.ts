import { afterEach, beforeEach, vi } from 'vitest';

import { TEST_NOW } from './now';

/**
 * Freezes the wall clock every module reads, for every test in both suites.
 *
 * Only `Date` is faked. Timers stay real so awaited work and Vitest's own
 * timeouts behave normally. Reinstalling before each test keeps a test that
 * moves or restores the clock itself from leaking into the next one.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TEST_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

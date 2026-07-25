import { describe, expect, it } from 'vitest';

import { capacityWarning } from './capacity';

describe('capacity warnings', () => {
  it('emits named 80% and 95% thresholds without blocking work below a threshold', () => {
    expect(capacityWarning(0.79)).toBeNull();
    expect(capacityWarning(0.8)).toBe('warning_80_percent');
    expect(capacityWarning(0.95)).toBe('warning_95_percent');
  });
});

import { describe, expect, it } from 'vitest';

import { pendingKey } from './pending';

const keyValues = (): string[] => Object.values(pendingKey).map((key) =>
  typeof key === 'function' ? key('subject', 'status') : key);

describe('operation keys', () => {
  it('gives every operation a key of its own, so no control reports another’s work', () => {
    const keys = keyValues();

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('separates two rows of the same kind of work', () => {
    expect(pendingKey.taskUpdate('task-1')).not.toBe(pendingKey.taskUpdate('task-2'));
    expect(pendingKey.promptUpdate('prompt-1')).not.toBe(pendingKey.promptDelete('prompt-1'));
    expect(pendingKey.portalAttendance('event-1', 'attending')).not.toBe(pendingKey.portalAttendance('event-1', 'not_attending'));
    expect(pendingKey.presetApply('membership-organization')).not.toBe(pendingKey.presetApply('other'));
  });
});

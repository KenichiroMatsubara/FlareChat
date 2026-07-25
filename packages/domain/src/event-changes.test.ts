import { describe, expect, it } from 'vitest';

import { classifyEventChange } from './event-changes';

describe('Event Changes', () => {
  it('classifies cancellation, modification, and creation messages before updating a Scheduled Event', () => {
    expect(classifyEventChange('例会は中止です')).toBe('cancel');
    expect(classifyEventChange('例会の開始時刻を変更します')).toBe('modify');
    expect(classifyEventChange('例会のお知らせ')).toBe('create');
  });
});

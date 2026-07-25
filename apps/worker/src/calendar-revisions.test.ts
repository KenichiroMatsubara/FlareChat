import { describe, expect, it } from 'vitest';
import { canApplyCalendarUpdate } from './calendar-revisions';
describe('Calendar revisions',()=>{it('does not overwrite a manual edit with stale source data',()=>{
  expect(canApplyCalendarUpdate({storedRevision:'etag-1',incomingRevision:'etag-1',hasManualOverride:false})).toBe(true);
  expect(canApplyCalendarUpdate({storedRevision:'etag-1',incomingRevision:'etag-0',hasManualOverride:true})).toBe(false);
});});

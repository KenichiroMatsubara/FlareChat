/**
 * Whether an automated write may be applied to a Scheduled Event. Manual
 * Override is a property of individual fields rather than of the whole event, so
 * a human's correction to one field no longer blocks a genuine change to
 * another; this is the last check that no locked field slipped into the write.
 * A write that changes nothing is refused so a no-op cannot reach the calendar.
 */
export const canApplyCalendarUpdate = (input: {
  storedRevision: string | null;
  incomingRevision: string | null;
  changedFields: readonly string[];
  lockedFields: readonly string[];
}): boolean => {
  if (!input.changedFields.length) return false;
  const locked = new Set(input.lockedFields);
  if (input.changedFields.some((field) => locked.has(field))) return false;
  return input.storedRevision === null || input.incomingRevision === null
    || input.storedRevision === input.incomingRevision;
};

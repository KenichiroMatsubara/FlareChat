export const canApplyCalendarUpdate = (input: { storedRevision: string | null; incomingRevision: string | null; hasManualOverride: boolean }): boolean =>
  !input.hasManualOverride && (input.storedRevision === null || input.incomingRevision === null || input.storedRevision === input.incomingRevision);

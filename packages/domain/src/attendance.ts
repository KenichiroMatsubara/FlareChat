export interface AttendanceLinkCheck {
  eventId: string;
  linkEventId: string;
  revokedAt: string | null;
  deadline: string;
  now: string;
}

/** Authorizes a public attendance update without exposing recipient data. */
export const canUpdateAttendance = (check: AttendanceLinkCheck): boolean =>
  check.eventId === check.linkEventId
  && check.revokedAt === null
  && Date.parse(check.now) < Date.parse(check.deadline);

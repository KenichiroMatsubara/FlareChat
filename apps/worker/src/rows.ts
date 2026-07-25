import type { AutomationRule, ScheduledEvent, TypedList } from '@mail/domain';

import type { EventRow, ListRow, RuleRow } from './types';

export const toList = (row: ListRow): TypedList => ({
  id: row.id,
  organizationId: row.organization_id,
  kind: row.kind,
  name: row.name,
  description: row.description,
  itemCount: row.item_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toRule = (row: RuleRow): AutomationRule => ({
  id: row.id,
  organizationId: row.organization_id,
  name: row.name,
  status: row.status,
  sourceListId: row.source_list_id,
  recipientListId: row.recipient_list_id,
  lineListId: row.line_list_id,
  scheduleMinutes: row.schedule_minutes,
  requireAttendance: row.require_attendance === 1,
  deadlineDaysBefore: row.deadline_days_before,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toEvent = (row: EventRow): ScheduledEvent => ({
  id: row.id,
  organizationId: row.organization_id,
  title: row.title,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  location: row.location,
  status: row.status,
  sourceSubject: row.source_subject ?? '',
  attendanceDeadline: row.attendance_deadline,
  attending: row.attending,
  notAttending: row.not_attending,
  unanswered: row.unanswered,
  updatedAt: row.updated_at,
});

export type OrganizationStatus = 'provisioning' | 'active' | 'suspended' | 'failed';
export type ListKind = 'source' | 'recipient' | 'line';
export type RuleStatus = 'draft' | 'active' | 'suspended' | 'archived';
export type EventStatus = 'draft' | 'scheduled' | 'cancelled' | 'exception';
export type AttendanceStatus = 'unanswered' | 'attending' | 'not_attending';

export interface Organization {
  id: string;
  name: string;
  inboxAddress: string;
  status: OrganizationStatus;
  createdAt: string;
}

export interface TypedList {
  id: string;
  organizationId: string;
  kind: ListKind;
  name: string;
  description: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListItem {
  id: string;
  listId: string;
  value: string;
  label: string;
  enabled: boolean;
}

export interface AutomationRule {
  id: string;
  organizationId: string;
  name: string;
  status: RuleStatus;
  sourceListId: string | null;
  recipientListId: string | null;
  lineListId: string | null;
  scheduleMinutes: number;
  requireAttendance: boolean;
  deadlineDaysBefore: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledEvent {
  id: string;
  organizationId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  status: EventStatus;
  sourceSubject: string;
  attendanceDeadline: string | null;
  attending: number;
  notAttending: number;
  unanswered: number;
  updatedAt: string;
}

export interface Dashboard {
  activeRules: number;
  upcomingEvents: number;
  pendingJobs: number;
  exceptions: number;
  lastSyncAt: string | null;
  events: ScheduledEvent[];
}

export interface ApiResult<T> {
  data: T;
}

export { batchLineMessages } from './line';
export type { LineBatch, LineMessage } from './line';

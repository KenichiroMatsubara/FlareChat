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

export type OrganizationRole = 'owner' | 'admin' | 'operator' | 'viewer';
export type SetupStatus =
  | 'awaiting_google'
  | 'awaiting_name'
  | 'provisioning'
  | 'active'
  | 'expired'
  | 'failed';

export type ProvisioningPhase =
  | 'allocating_database'
  | 'applying_schema'
  | 'storing_credentials'
  | 'verifying_binding'
  | 'activating_organization';

/** The non-secret state shown while an Organization is being created. */
export interface OrganizationSetup {
  id: string;
  name: string;
  inboxAddress: string | null;
  status: SetupStatus;
  expiresAt: string;
  provisioningExpiresAt: string | null;
  phase: ProvisioningPhase | null;
  error: string | null;
}

export interface PasskeyCreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout: number;
  authenticatorSelection: {
    residentKey: 'required';
    userVerification: 'required';
  };
  attestation: 'none';
}

export { batchLineMessages, discoveredLineDestinations, verifyLineWebhookSignature } from './line';
export type { LineBatch, LineDestination, LineMessage } from './line';
export { canUpdateAttendance } from './attendance';
export type { AttendanceLinkCheck } from './attendance';
export { MAX_ATTACHMENT_BYTES, MAX_SOURCE_MESSAGE_ATTACHMENT_BYTES, validateAttachmentIntake } from './attachments';
export type { AttachmentIntakeResult } from './attachments';
export { MAX_DELIVERY_ATTEMPTS, MAX_RETRY_WINDOW_MS, nextRetry } from './retry';
export type { RetryDecision } from './retry';
export { CAPACITY_CRITICAL_THRESHOLD, CAPACITY_WARNING_THRESHOLD, capacityWarning } from './capacity';
export type { CapacityWarning } from './capacity';
export { canConsumeRecipientLink } from './recipient-links';
export type { RecipientLinkCheck } from './recipient-links';
export { ATTENDANCE_REMINDER_DAYS, shouldSendAttendanceReminder } from './reminders';
export { classifyEventChange } from './event-changes';
export type { EventChangeKind } from './event-changes';
export { shouldWriteRecoveryReceipt } from './recovery';
export { displayRecipientIdentifier } from './privacy';

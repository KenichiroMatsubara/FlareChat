import type { AccountMembership } from './views';

export type ProvisioningPhase =
  | 'allocating_database'
  | 'applying_schema'
  | 'storing_credentials'
  | 'verifying_binding'
  | 'activating_organization';

export interface AppIdentity {
  email: string;
  displayName: string;
}

export type AppState =
  | { kind: 'signed_out' }
  | { kind: 'unassigned'; identity: AppIdentity }
  | {
    kind: 'confirming_organization';
    identity: AppIdentity;
    setup: { id: string; name: string; inboxAddress: string; expiresAt: string };
  }
  | {
    kind: 'provisioning';
    identity: AppIdentity;
    account: { id: string; name: string };
    phase: ProvisioningPhase | null;
  }
  | {
    kind: 'provisioning_failed';
    identity: AppIdentity;
    account: { id: string; name: string };
    phase: ProvisioningPhase | null;
    error: string | null;
    retryUntil: string;
  }
  | { kind: 'ready'; identity: AppIdentity; accounts: AccountMembership[] }
  | { kind: 'member'; identity: AppIdentity; account: { accountId: string; name: string } };

export type * from './views';

export { batchLineMessages, discoveredLineDestinations, verifyLineWebhookSignature } from './line';
export type { LineBatch, LineDestination, LineMessage } from './line';
export { canUpdateAttendance } from './attendance';
export type { AttendanceLinkCheck } from './attendance';
export {
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FOLDER_PATH_SEGMENTS,
  MAX_ATTACHMENT_FOLDER_SEGMENT_CHARACTERS,
  MAX_SOURCE_MESSAGE_ATTACHMENT_BYTES,
  MAX_SOURCE_MESSAGE_ATTACHMENTS,
  readAttachmentFolderPath,
  sourceMessageFolderName,
  validateAttachmentIntake,
} from './attachments';
export type { AttachmentFolderPathResult, AttachmentIntakeResult } from './attachments';
export {
  DEFAULT_RESPONSE_WINDOW_DAYS,
  MAX_RESPONSE_WINDOW_DAYS,
  MIN_RESPONSE_WINDOW_DAYS,
  readResponseWindowDays,
} from './responses';
export type { ResponseWindowRejection, ResponseWindowResult } from './responses';
export { MAX_DELIVERY_ATTEMPTS, MAX_RETRY_WINDOW_MS, nextRetry } from './retry';
export type { RetryDecision } from './retry';
export { CAPACITY_CRITICAL_THRESHOLD, CAPACITY_WARNING_THRESHOLD, capacityWarning } from './capacity';
export type { CapacityWarning } from './capacity';
export { canConsumeContactLink } from './member-links';
export type { ContactLinkCheck } from './member-links';
export {
  DEFAULT_ATTENDANCE_REMINDER_DAYS,
  DEFAULT_REMINDERS_ENABLED,
  DEFAULT_TASK_REMINDER_DAYS,
  readRemindersEnabled,
  writeRemindersEnabled,
  MAX_REMINDER_DAY,
  MAX_REMINDER_DAYS,
  MIN_ATTENDANCE_REMINDER_DAY,
  MIN_REMINDER_DAY,
  readReminderDays,
  shouldSendAttendanceReminder,
  shouldSendTaskReminder,
  writeReminderDays,
} from './reminders';
export type { ReminderDaysRejection, ReminderDaysResult } from './reminders';
export { classifyEventChange } from './event-changes';
export type { EventChangeKind } from './event-changes';
export { shouldWriteRecoveryReceipt } from './recovery';
export { displayLineDestinationId } from './privacy';

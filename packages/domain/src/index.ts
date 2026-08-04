export type OrganizationStatus = 'provisioning' | 'active' | 'suspended' | 'failed';
export type ListKind = 'source' | 'recipient' | 'line';
export type RuleStatus = 'draft' | 'active' | 'suspended' | 'archived';
export type AgentRuleStatus = 'active' | 'suspended' | 'archived';
export type AgentExecutionMode = 'read_only' | 'approval' | 'unattended';
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
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  scheduleMinutes: number;
  requireAttendance: boolean;
  deadlineDaysBefore: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Prompt {
  id: string;
  organizationId: string;
  name: string;
  instructions: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRule {
  id: string;
  organizationId: string;
  name: string;
  status: AgentRuleStatus;
  executionMode: AgentExecutionMode;
  promptId: string;
  selectionPolicy: Record<string, unknown>;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  priority: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunIndex {
  id: string;
  agentRuleId: string;
  agentRuleRevision: number;
  promptId: string;
  promptRevision: number;
  sourceMessageId: string;
  model: string;
  outcome: 'succeeded' | 'failed';
  toolCallCount: number;
  tokens: number;
  startedAt: string;
  completedAt: string;
  expiresAt: string;
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

export interface AppMembership {
  organizationId: string;
  name: string;
  status: string;
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
    organization: { id: string; name: string };
    phase: ProvisioningPhase | null;
  }
  | {
    kind: 'provisioning_failed';
    identity: AppIdentity;
    organization: { id: string; name: string };
    phase: ProvisioningPhase | null;
    error: string | null;
    retryUntil: string;
  }
  | { kind: 'ready'; identity: AppIdentity; organizations: AppMembership[] };

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
export { MAX_DELIVERY_ATTEMPTS, MAX_RETRY_WINDOW_MS, nextRetry } from './retry';
export type { RetryDecision } from './retry';
export { CAPACITY_CRITICAL_THRESHOLD, CAPACITY_WARNING_THRESHOLD, capacityWarning } from './capacity';
export type { CapacityWarning } from './capacity';
export { canConsumeMemberLink } from './member-links';
export type { MemberLinkCheck } from './member-links';
export { ATTENDANCE_REMINDER_DAYS, shouldSendAttendanceReminder } from './reminders';
export { classifyEventChange } from './event-changes';
export type { EventChangeKind } from './event-changes';
export { shouldWriteRecoveryReceipt } from './recovery';
export { displayLineDestinationId } from './privacy';

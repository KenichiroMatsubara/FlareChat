/**
 * The views the Worker's routes return and the GUI reads (ADR 0173).
 *
 * Each is declared here once, named as CONTEXT.md names the concept, so a
 * field added on one side reaches the other at compile time or fails there.
 */

export interface ApiResult<T> {
  data: T;
}

/** What a failed route says about itself, beyond its status. */
export interface ApiErrorDetails {
  message?: string;
  code?: string;
  category?: string;
  databaseKind?: 'control' | 'organization';
  databaseId?: string | null;
  bindingName?: string;
  currentMigration?: string;
  expectedMigration?: string;
  requestId?: string;
}

export interface ApiFailure {
  error?: ApiErrorDetails;
}

export type RuleState = 'draft' | 'active' | 'suspended' | 'archived';
export type ExecutionMode = 'read_only' | 'approval' | 'unattended';
export type ListKind = 'source' | 'recipient' | 'line';
export type AttendanceStatus = 'unanswered' | 'attending' | 'not_attending';
export type LineHandleKind = 'user' | 'group' | 'room';

export interface AccountMembership {
  accountId: string;
  name: string;
  status: string;
}

/** The Automation Inbox as it stands: its grant, its last run, and its totals. */
export interface AutomationStatus {
  email: string;
  displayName: string;
  enabled: boolean;
  status: 'active' | 'reauthentication_required' | 'disconnected';
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Set while scheduled runs keep failing; the Worker keeps retrying until it clears. */
  failingSince: string | null;
  created: number;
  skipped: number;
  exceptions: number;
}

/** What one run of the Automation Inbox did. */
export interface AutomationSummary {
  scanned: number;
  created: number;
  skipped: number;
  exceptions: number;
}

export interface Dashboard {
  activeRules: number;
  upcomingEvents: number;
  pendingJobs: number;
  exceptions: number;
  lastSyncedAt: string | null;
}

export interface Connections {
  accountId: string;
  accountName: string;
  line: {
    channelAccessTokenConfigured: boolean;
    channelSecretConfigured: boolean;
    webhookUrl: string;
  };
  ai: {
    apiKeyConfigured: boolean;
    model: string;
    baseUrl: string;
  };
}

/** The Guest Registrations on one Scheduled Event, as the Account reviews the roster. */
export interface GuestRegistrationRoster {
  eventId: string;
  title: string;
  startsAt: string;
  attendingCount: number;
  affiliations: Array<{ affiliation: string; attending: number }>;
  guests: Array<{ name: string; affiliation: string; attending: boolean }>;
}

export interface SchemaRule {
  id: string;
  accountId: string;
  name: string;
  state: RuleState;
  executionMode: ExecutionMode;
  revision: number;
  selectionPolicy: Record<string, unknown>;
  routingPolicy: Record<string, unknown>;
  /** The Contact List this Rule's Source Message Notice reaches, or null. */
  noticeContactListId: string | null;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaRuleInput {
  name: string;
  state: 'draft' | 'active';
  executionMode?: ExecutionMode;
  selectionPolicy?: Record<string, unknown>;
  routingPolicy?: Record<string, unknown>;
  noticeContactListId?: string | null;
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
  priority?: number;
}

export type SchemaRuleUpdate = Partial<Pick<SchemaRule, 'name' | 'state' | 'executionMode' | 'selectionPolicy' | 'priority' | 'noticeContactListId' | 'permittedRecipientListIds' | 'permittedLineListIds'>>;

export interface Prompt {
  id: string;
  accountId: string;
  name: string;
  instructions: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRule {
  id: string;
  accountId: string;
  name: string;
  state: RuleState;
  executionMode: ExecutionMode;
  promptId: string;
  selectionPolicy: Record<string, unknown>;
  permittedRecipientListIds: string[];
  permittedLineListIds: string[];
  priority: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuleInput {
  name: string;
  promptId: string;
  state: 'draft' | 'active';
  executionMode?: ExecutionMode;
  selectionPolicy: Record<string, unknown>;
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
  priority?: number;
}

export interface AgentRuleUpdate {
  state?: RuleState;
  executionMode?: ExecutionMode;
  promptId?: string;
  selectionPolicy?: Record<string, unknown>;
  permittedRecipientListIds?: string[];
  permittedLineListIds?: string[];
}

/** One Agent Rule run in the index, before its Run Transcript is opened. */
export interface AgentRun {
  id: string;
  agentRuleId: string;
  agentRuleRevision: number;
  promptId: string;
  promptRevision: number;
  sourceMessageId: string;
  model: string;
  startedAt: string;
  completedAt: string;
  outcome: 'succeeded' | 'failed';
  toolCallCount: number;
  tokens: number;
  expiresAt: string;
}

export interface RunTranscript {
  runId: string;
  source: { subject: string; body: string; attachments: Array<{ filename: string; text: string }> };
  messages: Array<{ role: string; content: string }>;
  finalOutput: string;
  error: string | null;
}

export type RuleEffectStatus = 'planned' | 'pending' | 'applying' | 'succeeded' | 'transient_failed' | 'permanent_failed' | 'blocked' | 'rejected' | 'expired';

export interface RuleEffect {
  id: string;
  key: string;
  kind: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
  status: RuleEffectStatus;
  attempts: number;
  result: unknown | null;
  error: string | null;
}

export type RuleRunStatus = 'planning' | 'read_only' | 'pending_approval' | 'applying' | 'completed' | 'rejected' | 'expired' | 'failed';

export interface RuleRun {
  id: string;
  rule: { type: 'schema' | 'agent'; id: string; revision: number };
  sourceMessageId: string;
  sourceMessage: { subject: string; sender: string; receivedAt: string };
  executionMode: ExecutionMode;
  intent: 'live' | 'draft_preview';
  status: RuleRunStatus;
  expiresAt: string | null;
  effects: RuleEffect[];
}

export interface TypedList {
  id: string;
  accountId: string;
  kind: ListKind;
  name: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TypedListInput {
  kind: ListKind;
  name: string;
  description?: string;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
}

export interface PresetApplication {
  presetId: string;
  typedLists: number;
  prompts: number;
  schemaRules: number;
  agentRules: number;
}

/** One Source Message withheld from every action until somebody looks at it. */
export interface AutomationException {
  id: string;
  sourceMessageId: string | null;
  code: string;
  message: string;
  state: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AutomationWarning {
  id: string;
  sourceMessageId: string;
  code: string;
  message: string;
  createdAt: string;
}

/** A Job that will not run itself: claimed and abandoned, or out of retries. */
export interface StuckJob {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  updatedAt: string;
}

export interface DeliveryRecord {
  id: string;
  eventId: string | null;
  sourceMessageId: string | null;
  channel: string;
  destination: string;
  outcome: string;
  externalId: string | null;
  createdAt: string;
}

export interface MailboxTestMatch {
  id: string;
  subject: string;
  sender: string;
}

/** The OpenAI-compatible JSON body prepared for review; credentials are never included. */
export interface MailboxTestAiRequest extends MailboxTestMatch {
  request: Record<string, unknown>;
}

export interface EventCandidate {
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  location: string;
  description: string;
  summary: string;
}

export interface TaskCandidate {
  title: string;
  deadline: string;
  assigneeContactId: string;
  description: string;
}

export interface MailboxTestPreview extends MailboxTestMatch {
  selectedRule: { id: string; revision: number };
  summary: string;
  events: EventCandidate[];
  tasks: TaskCandidate[];
  confirmationToken: string;
  expiresAt: string;
}

/** An existing Scheduled Event as it stands in Google Calendar right now. */
export interface ScheduledEvent {
  id: string;
  etag: string | null;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}

export interface EventRefreshRequest {
  existing: ScheduledEvent[];
  outOfWindow: ScheduledEvent[];
  request: Record<string, unknown> | null;
}

export interface EventRefreshEntry {
  candidateIndex: number;
  candidate: EventCandidate;
  target: ScheduledEvent | null;
  changedFields: string[];
  desired: {
    title: string;
    description: string;
    location: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
  } | null;
}

export interface EventRefreshPlan {
  entries: EventRefreshEntry[];
  unmatched: ScheduledEvent[];
  outOfWindow: ScheduledEvent[];
  pendingAttachments: string[];
  confirmationToken: string;
  expiresAt: string;
}

export interface EventRefreshOutcome {
  updated: string[];
  created: string[];
  conflicts: Array<{
    candidateIndex: number;
    googleEventId: string;
    etag: string | null;
    current: ScheduledEvent;
    changedFields: string[];
    candidate: EventCandidate;
  }>;
  failures: Array<{ googleEventId: string | null; title: string; message: string }>;
  confirmationToken: string | null;
  expiresAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  deadline: string;
  assigneeContactId: string | null;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  completedAt: string | null;
}

export interface TaskUpdate {
  completed?: boolean;
  remarks?: string;
  assigneeContactId?: string | null;
}

/** Whether an Account sends reminders, and on which Reminder Milestones. */
export interface ReminderCadence {
  enabled: boolean;
  days: number[];
}

export interface ReminderCadenceInput {
  days?: readonly number[];
  enabled?: boolean;
}

/** What a reminder is about: a Task's deadline or a Registration's Response Deadline. */
export type ReminderSubject = 'task' | 'registration';

/** One reminder the Reminder Schedule still has ahead of it, addressed and worded as it will arrive. */
export interface ScheduledReminder {
  subject: ReminderSubject;
  /** The Task or the Scheduled Event the reminder is about. */
  subjectId: string;
  title: string;
  deadline: string;
  contactId: string;
  contactName: string;
  channel: string;
  destination: string;
  milestone: number;
  sendOn: string;
  text: string;
}

/** A LINE Channel Handle as it hangs on one Contact. */
export interface LineHandle {
  id: string;
  destinationId: string;
  displayName: string;
  kind: LineHandleKind;
  status: 'discovered' | 'disabled';
  source: 'webhook' | 'manual';
}

/** A LINE Channel Handle in the Account's pool, whether or not a Contact holds it yet. */
export interface LineHandleRecord extends LineHandle {
  discoveredAt: string;
  contactId: string | null;
}

export interface LineHandleInput {
  destinationId: string;
  kind?: LineHandleKind;
  displayName?: string;
}

export interface Contact {
  id: string;
  accountId: string;
  name: string;
  email: string;
  state: 'active' | 'inactive';
  /** What kind of Contact this is, in the Account's own words. */
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lineDestinations: LineHandle[];
}

export interface ContactInput {
  name: string;
  email?: string;
  description?: string;
  tags?: string[];
  lineDestinationId?: string;
}

export type ContactUpdate = Partial<Pick<Contact, 'name' | 'email' | 'description' | 'tags' | 'state'>>;

/** One Contact a test message can actually be sent to, and on which Channels. */
export interface ChannelTestTarget {
  id: string;
  name: string;
  email: string;
  state: string;
  channels: string[];
}

export interface ChannelTestDelivery {
  delivered: boolean;
  channel: string;
  contactId: string;
  destination: string;
  /** How many messages were meant to arrive, and how many provider requests carried them. */
  messages: number;
  requests: number;
  externalId: string | null;
  sentAt: string;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  revision: string | null;
  authenticated: boolean;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  url: string;
  token: string | null;
}

export interface McpServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerToolResult {
  server: string;
  tool: string;
  isError: boolean;
  text: string;
}

export interface AutomationInput {
  name: string;
  promptId: string;
  contactListId: string | null;
  schedule: string;
  offsetMinutes: number;
  executionMode: string;
  suppressionWindow: string;
  state: string;
  tools: string[];
}

export interface Automation extends AutomationInput {
  id: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface AutomationRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  output: string | null;
  error: string | null;
  toolCalls: number;
}

export interface ContactList {
  id: string;
  name: string;
  description: string;
  contactIds: string[];
}

export interface ContactListInput {
  name: string;
  contactIds: string[];
}

export interface AccessToken {
  id: string;
  name: string;
  contactListId: string;
  suppressionWindow: string;
  callsPerHour: number;
  writesPerDay: number;
  lastUsedAt: string | null;
  tools: string[];
}

export interface AccessTokenInput {
  name: string;
  contactListId: string;
  tools: string[];
  suppressionWindow: string;
}

/** The credential exactly once, because only its hash is kept. */
export interface IssuedAccessToken {
  id: string;
  name: string;
  tools: string[];
  token: string;
  url: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatTurn {
  id: string;
  position: number;
  request: string;
  response: string | null;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
  ruleRunId: string;
}

export interface ChatReply {
  conversationId: string;
  turnId: string;
  ruleRunId: string;
  response: string;
  toolCallCount: number;
  unreachableServers: Array<{ server: string; error: string }>;
}

export interface ContactPageEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  registrationDeadline: string | null;
  status: AttendanceStatus;
  comment: string;
  open: boolean;
}

export interface ContactPageTask {
  taskId: string;
  title: string;
  deadline: string;
  assigneeName: string;
  sourceMessageSubject: string;
  description: string;
  remarks: string;
  completed: boolean;
  mine: boolean;
}

/** The one page a Contact has: its attendance, its comments, and its Tasks. */
export interface ContactPage {
  account: { accountId: string; name: string };
  contact: { contactId: string; name: string };
  events: ContactPageEvent[];
  tasks: ContactPageTask[];
}

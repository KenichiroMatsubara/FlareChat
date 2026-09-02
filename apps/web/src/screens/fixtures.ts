import type { AgentRule, AgentRun, AppState, Automation, AutomationException, AutomationStatus, ChatTurn, Connections, Contact, ContactList, DeliveryRecord, LineHandleRecord, Prompt, ReminderCadence, RuleRun, RunTranscript, SchemaRule, Task, TypedList } from '@mail/domain';

/** The one Account every screen test signs into. */
export const ACCOUNT_ID = 'org-1';

export const ready: AppState = {
  kind: 'ready',
  identity: { email: 'owner@example.com', displayName: 'Owner' },
  accounts: [{ accountId: ACCOUNT_ID, name: 'Example', status: 'active' }],
};

export const automationStatus = (overrides: Partial<AutomationStatus> = {}): AutomationStatus => ({
  email: 'inbox@example.com',
  displayName: 'Inbox',
  enabled: true,
  status: 'active',
  lastSyncedAt: '2026-08-18T09:00:00.000Z',
  lastError: null,
  failingSince: null,
  created: 4,
  skipped: 2,
  exceptions: 0,
  ...overrides,
});

export const connections = (overrides: Partial<Connections> = {}): Connections => ({
  accountId: ACCOUNT_ID,
  accountName: 'Example',
  line: { channelAccessTokenConfigured: true, channelSecretConfigured: true, webhookUrl: 'https://flarechat.example/api/line/webhook' },
  ai: { apiKeyConfigured: true, model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' },
  ...overrides,
});

export const schemaRule = (overrides: Partial<SchemaRule> = {}): SchemaRule => ({
  id: 'rule-1',
  accountId: ACCOUNT_ID,
  name: 'Announcements',
  state: 'active',
  executionMode: 'unattended',
  revision: 2,
  selectionPolicy: { domain: 'example.org' },
  routingPolicy: {},
  noticeContactListId: null,
  permittedRecipientListIds: [],
  permittedLineListIds: [],
  priority: 10,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

export const agentRule = (overrides: Partial<AgentRule> = {}): AgentRule => ({
  id: 'agent-1',
  accountId: ACCOUNT_ID,
  name: 'Triage',
  state: 'draft',
  executionMode: 'read_only',
  promptId: 'prompt-1',
  selectionPolicy: {},
  permittedRecipientListIds: [],
  permittedLineListIds: [],
  priority: 0,
  revision: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

export const prompt = (overrides: Partial<Prompt> = {}): Prompt => ({
  id: 'prompt-1',
  accountId: ACCOUNT_ID,
  name: 'Morning check',
  instructions: 'List what is due.',
  revision: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

export const contact = (overrides: Partial<Contact> = {}): Contact => ({
  id: 'contact-1',
  accountId: ACCOUNT_ID,
  name: '山田 太郎',
  email: 'taro@example.com',
  state: 'active',
  description: '会計',
  tags: ['2026'],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  lineDestinations: [],
  ...overrides,
});

export const lineHandle = (overrides: Partial<LineHandleRecord> = {}): LineHandleRecord => ({
  id: 'handle-1',
  destinationId: 'Uabc1',
  displayName: '花子',
  kind: 'user',
  status: 'discovered',
  source: 'webhook',
  discoveredAt: '2026-08-01T00:00:00.000Z',
  contactId: null,
  ...overrides,
});

export const contactList = (overrides: Partial<ContactList> = {}): ContactList => ({
  id: 'list-1',
  name: '定例連絡',
  description: '',
  contactIds: ['contact-1'],
  ...overrides,
});

export const typedList = (overrides: Partial<TypedList> = {}): TypedList => ({
  id: 'typed-1',
  accountId: ACCOUNT_ID,
  kind: 'recipient',
  name: 'Board',
  description: '',
  ...overrides,
});

export const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '参加費を振り込む',
  deadline: '2026-09-10',
  assigneeContactId: 'contact-1',
  assigneeName: '山田 太郎',
  sourceMessageSubject: '総会案内',
  description: '',
  remarks: '',
  completed: false,
  completedAt: null,
  ...overrides,
});

export const cadence = (overrides: Partial<ReminderCadence> = {}): ReminderCadence => ({ enabled: true, days: [7, 3, 1, 0], ...overrides });

export const ruleRun = (overrides: Partial<RuleRun> = {}): RuleRun => ({
  id: 'run-1',
  rule: { type: 'schema', id: 'rule-1', revision: 2 },
  sourceMessageId: 'message-1',
  sourceMessage: { subject: '総会案内', sender: 'sender@example.org', receivedAt: '2026-08-18T09:00:00.000Z' },
  executionMode: 'approval',
  intent: 'live',
  status: 'pending_approval',
  expiresAt: null,
  effects: [],
  ...overrides,
});

export const delivery = (overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: 'delivery-1',
  eventId: null,
  sourceMessageId: 'message-1',
  channel: 'line',
  destination: 'Uabc1',
  outcome: 'succeeded',
  externalId: null,
  createdAt: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

export const exception = (overrides: Partial<AutomationException> = {}): AutomationException => ({
  id: 'exception-1',
  sourceMessageId: 'message-1',
  code: 'ai_connection_missing',
  message: 'No AI Connection is configured.',
  state: 'open',
  createdAt: '2026-08-18T09:00:00.000Z',
  resolvedAt: null,
  ...overrides,
});

export const chatTurn = (overrides: Partial<ChatTurn> = {}): ChatTurn => ({
  id: 'turn-1',
  position: 1,
  request: '来週の予定は?',
  response: '2件です。',
  status: 'completed',
  error: null,
  ruleRunId: 'run-1',
  ...overrides,
});

export const automation = (overrides: Partial<Automation> = {}): Automation => ({
  id: 'automation-1',
  name: '朝の確認',
  promptId: 'prompt-1',
  contactListId: null,
  schedule: 'daily 09:00',
  offsetMinutes: 540,
  executionMode: 'unattended',
  suppressionWindow: 'day',
  state: 'active',
  tools: ['query_tasks'],
  nextRunAt: '2026-09-03T00:00:00.000Z',
  lastRunAt: null,
  lastError: null,
  ...overrides,
});

export const agentRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'agent-run-1',
  agentRuleId: 'agent-1',
  agentRuleRevision: 1,
  promptId: 'prompt-1',
  promptRevision: 1,
  sourceMessageId: 'message-1',
  model: 'gpt-4.1-mini',
  startedAt: '2026-08-18T09:00:00.000Z',
  completedAt: '2026-08-18T09:00:05.000Z',
  outcome: 'succeeded',
  toolCallCount: 2,
  tokens: 900,
  expiresAt: '2026-09-18T09:00:05.000Z',
  ...overrides,
});

export const transcript = (overrides: Partial<RunTranscript> = {}): RunTranscript => ({
  runId: 'agent-run-1',
  source: { subject: '総会案内', body: '本文です。', attachments: [] },
  messages: [],
  finalOutput: '予定を1件作成しました。',
  error: null,
  ...overrides,
});

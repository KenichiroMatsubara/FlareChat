import type {
  AccessToken,
  AccessTokenInput,
  AgentRule,
  AgentRuleInput,
  AgentRuleUpdate,
  AgentRun,
  ApiErrorDetails,
  ApiFailure,
  ApiResult,
  AppState,
  AttendanceStatus,
  Automation,
  AutomationException,
  AutomationInput,
  AutomationRun,
  AutomationStatus,
  AutomationSummary,
  AutomationWarning,
  ChannelTestDelivery,
  ChannelTestTarget,
  ChatReply,
  ChatTurn,
  Connections,
  Contact,
  ContactInput,
  ContactList,
  ContactListInput,
  ContactPage,
  ContactUpdate,
  Conversation,
  Dashboard,
  DeliveryRecord,
  EventRefreshOutcome,
  EventRefreshPlan,
  EventRefreshRequest,
  GuestRegistrationRoster,
  IssuedAccessToken,
  LineHandle,
  LineHandleInput,
  LineHandleRecord,
  MailboxTestAiRequest,
  MailboxTestMatch,
  MailboxTestPreview,
  McpServer,
  McpServerInput,
  McpServerTool,
  McpServerToolResult,
  Preset,
  PresetApplication,
  Prompt,
  ReminderCadence,
  ReminderCadenceInput,
  RuleRun,
  RunTranscript,
  SchemaRule,
  SchemaRuleInput,
  SchemaRuleUpdate,
  StuckJob,
  Task,
  ScheduledReminder,
  TaskUpdate,
  TypedList,
  TypedListInput,
} from '@mail/domain';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly category: string | undefined;
  readonly databaseKind: 'control' | 'organization' | undefined;
  readonly databaseId: string | null | undefined;
  readonly bindingName: string | undefined;
  readonly currentMigration: string | undefined;
  readonly expectedMigration: string | undefined;
  readonly requestId: string | undefined;

  constructor(error: ApiErrorDetails, status: number) {
    const message = error.code === 'schema_not_ready'
      ? `データベースのマイグレーション状態が不正です（${error.databaseKind ?? 'unknown'}: 現在 ${error.currentMigration ?? '不明'} / 期待 ${error.expectedMigration ?? '不明'}、request ID: ${error.requestId ?? '不明'}）。`
      : error.message ?? 'サービスに接続できませんでした。時間をおいて画面を再読み込みしてください。';
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.category = error.category;
    this.databaseKind = error.databaseKind;
    this.databaseId = error.databaseId;
    this.bindingName = error.bindingName;
    this.currentMigration = error.currentMigration;
    this.expectedMigration = error.expectedMigration;
    this.requestId = error.requestId;
  }
}

const responseBody = async <T>(response: Response): Promise<(ApiResult<T> & ApiFailure) | null> => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as ApiResult<T> & ApiFailure; }
  catch { throw new Error('サービスから正しい応答を受け取れませんでした。URLを確認して画面を再読み込みしてください。'); }
};

/** The one seam every request passes through: cookies, JSON, and the Worker's failure shape. */
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await responseBody<T>(response);
  if (!response.ok) throw new ApiError(body?.error ?? {}, response.status);
  if (!body) throw new Error('サービスから応答がありませんでした。画面を再読み込みしてください。');
  return body.data;
};

const account = (accountId: string, path = ''): string => `/api/organizations/${encodeURIComponent(accountId)}${path}`;
const segment = (value: string): string => encodeURIComponent(value);
const post = <T>(path: string, body?: unknown): Promise<T> => request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const put = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown): Promise<T> => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const remove = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

export const api = {
  bootstrap: (): Promise<AppState> => request('/api/bootstrap'),
  beginGoogleEntry: (intent: 'login' | 'organization_setup'): Promise<{ authorizationUrl: string }> => post('/api/entry/google', { intent }),
  logout: (): Promise<{ loggedOut: boolean }> => post('/api/auth/logout'),
  presets: (): Promise<Preset[]> => request('/api/presets'),
  confirmOnboarding: (name: string, presetId?: string): Promise<{ accepted: boolean }> => post('/api/onboarding/confirm', { name, ...(presetId ? { presetId } : {}) }),
  retryOnboarding: (): Promise<{ accepted: boolean }> => post('/api/onboarding/retry'),
  cancelOnboarding: (): Promise<{ cancelled: boolean }> => remove('/api/onboarding'),

  joinContactPage: (accountId: string, token: string): Promise<{ contactId: string; name: string }> => post(`/api/member-links/${segment(accountId)}/${segment(token)}`, {}),
  contactPage: (): Promise<ContactPage> => request('/api/portal'),
  registerContactAttendance: (eventId: string, input: { status: AttendanceStatus; comment: string }): Promise<{ eventId: string }> => put(`/api/portal/events/${segment(eventId)}/attendance`, input),
  updateContactTask: (taskId: string, input: { completed?: boolean; remarks?: string }): Promise<{ taskId: string }> => patch(`/api/portal/tasks/${segment(taskId)}`, input),

  currentAutomation: (accountId: string): Promise<AutomationStatus | null> => request(account(accountId, '/automation')),
  reauthorizeAutomationInbox: (accountId: string): Promise<{ authorizationUrl: string }> => post(account(accountId, '/automation/reauthorize')),
  runAutomation: (accountId: string): Promise<AutomationSummary> => post(account(accountId, '/automation/run')),
  setEnabled: (accountId: string, enabled: boolean): Promise<{ enabled: boolean }> => post(account(accountId, '/automation/enabled'), { enabled }),
  dashboard: (accountId: string): Promise<Dashboard> => request(account(accountId, '/dashboard')),
  guestRegistrations: (accountId: string): Promise<GuestRegistrationRoster[]> => request(account(accountId, '/guest-registrations')),

  rules: (accountId: string): Promise<SchemaRule[]> => request(account(accountId, '/rules')),
  createRule: (accountId: string, input: SchemaRuleInput): Promise<SchemaRule> => post(account(accountId, '/rules'), input),
  updateRule: (accountId: string, ruleId: string, input: SchemaRuleUpdate): Promise<Partial<SchemaRule> & { id: string }> => patch(account(accountId, `/rules/${segment(ruleId)}`), input),
  prompts: (accountId: string): Promise<Prompt[]> => request(account(accountId, '/prompts')),
  createPrompt: (accountId: string, input: { name: string; instructions: string }): Promise<Prompt> => post(account(accountId, '/prompts'), input),
  updatePrompt: (accountId: string, promptId: string, input: { name?: string; instructions?: string }): Promise<Partial<Prompt> & { id: string }> => patch(account(accountId, `/prompts/${segment(promptId)}`), input),
  removePrompt: (accountId: string, promptId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/prompts/${segment(promptId)}`)),
  agentRules: (accountId: string): Promise<AgentRule[]> => request(account(accountId, '/agent-rules')),
  createAgentRule: (accountId: string, input: AgentRuleInput): Promise<AgentRule> => post(account(accountId, '/agent-rules'), input),
  updateAgentRule: (accountId: string, agentRuleId: string, input: AgentRuleUpdate): Promise<AgentRule> => patch(account(accountId, `/agent-rules/${segment(agentRuleId)}`), input),
  agentRuns: (accountId: string): Promise<AgentRun[]> => request(account(accountId, '/agent-runs')),
  runTranscript: (accountId: string, runId: string): Promise<RunTranscript> => request(account(accountId, `/agent-runs/${segment(runId)}/transcript`)),
  ruleRuns: (accountId: string): Promise<RuleRun[]> => request(account(accountId, '/rule-runs')),
  decideRuleRun: (accountId: string, runId: string, decision: 'approve' | 'reject'): Promise<RuleRun> => post(account(accountId, `/rule-runs/${segment(runId)}/decision`), { decision }),
  applyPreset: (accountId: string, presetId: string, conflictPolicy?: 'duplicate'): Promise<PresetApplication> => post(account(accountId, `/presets/${segment(presetId)}/apply`), conflictPolicy ? { conflictPolicy } : {}),

  lists: (accountId: string): Promise<TypedList[]> => request(account(accountId, '/lists')),
  createList: (accountId: string, input: TypedListInput): Promise<TypedList> => post(account(accountId, '/lists'), input),
  addListItem: (accountId: string, listId: string, input: { value: string; label?: string }): Promise<{ id: string }> => post(account(accountId, `/lists/${segment(listId)}/items`), input),
  setListItemEnabled: (accountId: string, listId: string, itemId: string, enabled: boolean): Promise<{ id: string }> => patch(account(accountId, `/lists/${segment(listId)}/items/${segment(itemId)}`), { enabled }),

  exceptions: (accountId: string): Promise<AutomationException[]> => request(account(accountId, '/operations/exceptions')),
  resolveException: (accountId: string, id: string): Promise<{ id: string }> => patch(account(accountId, `/operations/exceptions/${segment(id)}`), { state: 'resolved' }),
  warnings: (accountId: string): Promise<AutomationWarning[]> => request(account(accountId, '/automation-warnings')),
  stuckJobs: (accountId: string): Promise<StuckJob[]> => request(account(accountId, '/operations/jobs')),
  setSuspension: (accountId: string, suspended: boolean): Promise<{ accountId: string; status: string }> => patch(account(accountId, '/suspension'), { suspended }),
  deliveries: (accountId: string): Promise<DeliveryRecord[]> => request(account(accountId, '/audit/deliveries')),

  tasks: (accountId: string): Promise<Task[]> => request(account(accountId, '/tasks')),
  updateTask: (accountId: string, taskId: string, input: TaskUpdate): Promise<Task> => patch(account(accountId, `/tasks/${segment(taskId)}`), input),
  taskReminders: (accountId: string): Promise<ReminderCadence> => request(account(accountId, '/task-reminders')),
  saveTaskReminders: (accountId: string, input: ReminderCadenceInput): Promise<ReminderCadence> => put(account(accountId, '/task-reminders'), input),
  attendanceReminders: (accountId: string): Promise<ReminderCadence> => request(account(accountId, '/attendance-reminders')),
  saveAttendanceReminders: (accountId: string, input: ReminderCadenceInput): Promise<ReminderCadence> => put(account(accountId, '/attendance-reminders'), input),
  reminderSchedule: (accountId: string): Promise<ScheduledReminder[]> => request(account(accountId, '/reminders/schedule')),

  connections: (accountId: string): Promise<Connections> => request(account(accountId, '/connections')),
  saveLineConnection: (accountId: string, input: { channelAccessToken?: string | undefined; channelSecret?: string | undefined }): Promise<Connections['line']> => put(account(accountId, '/connections/line'), input),
  saveAiConnection: (accountId: string, input: { apiKey?: string | undefined; model?: string | undefined; baseUrl?: string | undefined }): Promise<Connections['ai']> => put(account(accountId, '/connections/ai'), input),
  testAiConnection: (accountId: string, prompt: string): Promise<{ text: string; model: string }> => post(account(accountId, '/connections/ai/test'), { prompt }),
  saveDiscordConnection: (accountId: string, input: { botToken: string; applicationPublicKey: string }): Promise<{ configured: boolean; interactionsUrl: string }> => put(account(accountId, '/connections/discord'), input),
  attachmentFolder: (accountId: string): Promise<{ path: string }> => request(account(accountId, '/attachment-folder')),
  saveAttachmentFolder: (accountId: string, path: string): Promise<{ path: string }> => put(account(accountId, '/attachment-folder'), { path }),
  responseWindow: (accountId: string): Promise<{ days: number }> => request(account(accountId, '/response-window')),
  saveResponseWindow: (accountId: string, days: number): Promise<{ days: number }> => put(account(accountId, '/response-window'), { days }),

  contacts: (accountId: string): Promise<Contact[]> => request(account(accountId, '/members')),
  createContact: (accountId: string, input: ContactInput): Promise<Contact> => post(account(accountId, '/members'), input),
  updateContact: (accountId: string, contactId: string, input: ContactUpdate): Promise<Partial<Contact> & { id: string }> => patch(account(accountId, `/members/${segment(contactId)}`), input),
  deleteContact: (accountId: string, contactId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/members/${segment(contactId)}`)),
  setContactLineHandle: (accountId: string, contactId: string, input: LineHandleInput): Promise<LineHandle> => put(account(accountId, `/members/${segment(contactId)}/line-destination`), input),
  removeContactLineHandle: (accountId: string, contactId: string, lineDestinationId: string): Promise<{ id: string; unlinked: boolean }> => remove(account(accountId, `/members/${segment(contactId)}/line-destination/${segment(lineDestinationId)}`)),
  lineHandles: (accountId: string): Promise<LineHandleRecord[]> => request(account(accountId, '/line-destinations')),
  registerLineHandle: (accountId: string, input: LineHandleInput): Promise<LineHandleRecord> => post(account(accountId, '/line-destinations'), input),
  removeLineHandle: (accountId: string, lineDestinationId: string): Promise<{ id: string; removed: boolean }> => remove(account(accountId, `/line-destinations/${segment(lineDestinationId)}`)),
  contactImportPreview: (accountId: string, csv: string): Promise<unknown> => post(account(accountId, '/members/import/preview'), { csv }),
  importContacts: (accountId: string, csv: string): Promise<unknown> => post(account(accountId, '/members/import'), { csv }),
  contactExportUrl: (accountId: string): string => account(accountId, '/members/export'),
  channelTestTargets: (accountId: string): Promise<ChannelTestTarget[]> => request(account(accountId, '/channel-tests/targets')),
  sendChannelTest: (accountId: string, input: { contactId: string; channel: string; texts: string[] }): Promise<ChannelTestDelivery> => post(account(accountId, '/channel-tests'), input),
  contactLists: (accountId: string): Promise<ContactList[]> => request(account(accountId, '/contact-lists')),
  saveContactList: (accountId: string, id: string, input: ContactListInput): Promise<{ id: string }> => put(account(accountId, `/contact-lists/${segment(id)}`), input),

  searchMailbox: (accountId: string, subject: string): Promise<{ messages: MailboxTestMatch[] }> => post(account(accountId, '/mail-tests/search'), { subject }),
  prepareMailboxAiRequest: (accountId: string, messageId: string): Promise<MailboxTestAiRequest> => post(account(accountId, `/mail-tests/${segment(messageId)}/ai-request`)),
  previewMailboxEvents: (accountId: string, messageId: string): Promise<MailboxTestPreview> => post(account(accountId, `/mail-tests/${segment(messageId)}/preview`)),
  previewDraftRule: (accountId: string, messageId: string, ruleId: string): Promise<MailboxTestPreview> => post(account(accountId, `/mail-tests/${segment(messageId)}/draft-preview`), { ruleId }),
  createMailboxEvents: (accountId: string, confirmationToken: string): Promise<{ eventIds: string[] }> => post(account(accountId, '/mail-tests/calendar'), { confirmationToken }),
  startDraftRuleRun: (accountId: string, confirmationToken: string, ruleId: string): Promise<RuleRun> => post(account(accountId, '/mail-tests/rule-run'), { confirmationToken, ruleId }),
  prepareEventRefresh: (accountId: string, messageId: string, confirmationToken: string): Promise<EventRefreshRequest> => post(account(accountId, `/mail-tests/${segment(messageId)}/refresh-request`), { confirmationToken }),
  planEventRefresh: (accountId: string, messageId: string, confirmationToken: string): Promise<EventRefreshPlan> => post(account(accountId, `/mail-tests/${segment(messageId)}/refresh-plan`), { confirmationToken }),
  applyEventRefresh: (accountId: string, confirmationToken: string, candidateIndexes: number[]): Promise<EventRefreshOutcome> => post(account(accountId, '/mail-tests/refresh'), { confirmationToken, candidateIndexes }),

  mcpServers: (accountId: string): Promise<McpServer[]> => request(account(accountId, '/mcp-servers')),
  saveMcpServer: (accountId: string, id: string, input: McpServerInput): Promise<{ id: string }> => put(account(accountId, `/mcp-servers/${segment(id)}`), input),
  removeMcpServer: (accountId: string, id: string): Promise<{ id: string }> => remove(account(accountId, `/mcp-servers/${segment(id)}`)),
  listMcpServerTools: (accountId: string, serverId: string): Promise<{ server: string; tools: McpServerTool[] }> => post(account(accountId, `/mcp-servers/${segment(serverId)}/tests`), {}),
  callMcpServerTool: (accountId: string, serverId: string, input: { tool: string; arguments: Record<string, unknown> }): Promise<McpServerToolResult> => post(account(accountId, `/mcp-servers/${segment(serverId)}/tests`), input),
  conversations: (accountId: string): Promise<Conversation[]> => request(account(accountId, '/chat')),
  chatTurns: (accountId: string, conversationId: string): Promise<ChatTurn[]> => request(account(accountId, `/chat/${segment(conversationId)}`)),
  sendChatMessage: (accountId: string, input: { conversationId: string | null; message: string }): Promise<ChatReply> => post(account(accountId, '/chat'), input),
  accessTokens: (accountId: string): Promise<AccessToken[]> => request(account(accountId, '/access-tokens')),
  issueAccessToken: (accountId: string, input: AccessTokenInput): Promise<IssuedAccessToken> => post(account(accountId, '/access-tokens'), input),
  revokeAccessToken: (accountId: string, id: string): Promise<{ id: string }> => remove(account(accountId, `/access-tokens/${segment(id)}`)),
  automations: (accountId: string): Promise<Automation[]> => request(account(accountId, '/automations')),
  saveAutomation: (accountId: string, id: string, input: AutomationInput): Promise<{ id: string; nextRunAt: string | null }> => put(account(accountId, `/automations/${segment(id)}`), input),
  removeAutomation: (accountId: string, id: string): Promise<{ id: string }> => remove(account(accountId, `/automations/${segment(id)}`)),
  automationRuns: (accountId: string, id: string): Promise<AutomationRun[]> => request(account(accountId, `/automations/${segment(id)}/runs`)),
};

export type Api = typeof api;

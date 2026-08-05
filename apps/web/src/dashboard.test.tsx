import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Dashboard, GoogleReauthenticationAction, NAVIGATION_PANEL_ID, needsGoogleReauthentication, type DashboardProps } from './dashboard';
import { pendingKey } from './pending';

describe('Google credential recovery', () => {
  it('offers an Automation Inbox reconnection action for a revoked or expired token', () => {
    expect(needsGoogleReauthentication('Token has been expired or revoked.')).toBe(true);
    expect(renderToStaticMarkup(<GoogleReauthenticationAction onClick={() => undefined} />)).toContain('Automation Inbox を再接続する');
  });

  it('does not misclassify unrelated operation errors as credential recovery', () => {
    expect(needsGoogleReauthentication('Google Calendar が応答しませんでした。')).toBe(false);
  });
});

const dashboardProps = (): DashboardProps => ({
  page: 'automation', automation: null, summary: null, error: '',
  isPending: () => false, isSettled: () => false, navigating: false, runningOperations: [],
  onRun: vi.fn(), onSetEnabled: vi.fn(), onLogout: vi.fn(), onReauthenticate: vi.fn(),
  organization: { name: 'Example' }, organizationId: 'org-1',
  organizations: [{ organizationId: 'org-1', name: 'Example', status: 'active' }],
  connections: null, lineChannelAccessToken: '', lineChannelSecret: '', aiApiKey: '', aiModel: 'test-model', aiBaseUrl: 'https://ai.example.com/v1',
  onLineChannelAccessTokenChange: vi.fn(), onLineChannelSecretChange: vi.fn(), onAiApiKeyChange: vi.fn(), onAiModelChange: vi.fn(), onAiBaseUrlChange: vi.fn(),
  onSaveLineConnection: vi.fn(), onSaveAiConnection: vi.fn(), aiTestPrompt: '', aiTestResult: '',
  onAiTestPromptChange: vi.fn(), onTestAi: vi.fn(), mailTestSubject: '', mailTestMatches: [], mailTestAiRequest: null,
  mailTestPreview: null, mailTestCreatedEventIds: [],
  mailTestRefreshRequest: null, mailTestRefreshPlan: null, mailTestRefreshOutcome: null,
  onPrepareRefresh: vi.fn(), onPlanRefresh: vi.fn(), onApplyRefresh: vi.fn(), onMailTestSubjectChange: vi.fn(), onSearchMailbox: vi.fn(),
  onPrepareMailbox: vi.fn(), onPreviewMailbox: vi.fn(), onCreateCalendarEvent: vi.fn(), organizationRules: [],
  organizationLists: [], onCreateRule: vi.fn(), onUpdateRule: vi.fn(), organizationTasks: [], onUpdateTask: vi.fn(), taskRoles: [], taskRoleAssignments: [], taskMembers: [], onCreateTaskRole: vi.fn(), onUpdateTaskRole: vi.fn(), onDeleteTaskRole: vi.fn(), onAssignTaskRole: vi.fn(),
  taskReassignment: { rolesChangedAt: null, reviewedAt: null, pending: false, openTasks: 0 }, taskReassignmentProposals: [], taskReassignmentSkipped: [],
  onSuggestTaskReassignments: vi.fn(), onApplyTaskReassignments: vi.fn(), onDiscardTaskReassignments: vi.fn(),
  prompts: [], agentRules: [], agentRuns: [], agentTranscript: null, proposedActions: [], onCreatePrompt: vi.fn(), onUpdatePrompt: vi.fn(), onDeletePrompt: vi.fn(), onCreateAgentRule: vi.fn(), onUpdateAgentRule: vi.fn(), onLoadAgentTranscript: vi.fn(), onDecideProposedAction: vi.fn(), onDecideProposedActionBatch: vi.fn(),
  organizationMembers: [], lineDestinations: [], onCreateMember: vi.fn(), onUpdateMember: vi.fn(),
  onSetLineDestination: vi.fn(), onUnlinkLineDestination: vi.fn(), onRegisterLineDestination: vi.fn(), onRemoveLineDestination: vi.fn(), onRefreshMembers: vi.fn(),
  guestRegistrations: [],
  attachmentFolderPath: 'Mail Automation', savedAttachmentFolderPath: 'Mail Automation', onAttachmentFolderPathChange: vi.fn(), onSaveAttachmentFolderPath: vi.fn(),
  presets: [{ id: 'membership-organization', name: 'Membership organization', description: 'Starting configuration.' }], onApplyPreset: vi.fn(),
});

const markup = (): string => renderToStaticMarkup(
  <MemoryRouter initialEntries={['/organizations/org-1/automation']}><Dashboard {...dashboardProps()} /></MemoryRouter>,
);

describe('responsive dashboard shell', () => {
  it('collapses navigation behind a labelled toggle that starts closed', () => {
    const html = markup();
    expect(html).toContain(`aria-controls="${NAVIGATION_PANEL_ID}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="メニューを開く"');
    expect(html).toContain(`id="${NAVIGATION_PANEL_ID}"`);
    expect(html).toContain('class="topbar-panel"');
    expect(html).not.toContain('topbar-scrim');
  });

  it('keeps every navigation target inside the collapsible panel', () => {
    const panel = /<div id="app-navigation" class="topbar-panel">(.*?)<\/header>/su.exec(markup())?.[1] ?? '';
    expect(panel).toContain('class="organization-picker"');
    for (const label of ['自動化', '接続設定', 'ルール', 'メンバー', 'タスク', 'メールテスト', 'ログアウト']) expect(panel).toContain(label);
  });

  it('stacks the AI request heading and its copy action on narrow screens', async () => {
    const stylesheet = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

    expect(stylesheet).toContain('@media (max-width: 560px) {\n  .ai-request-heading { flex-direction: column; }');
    expect(stylesheet).toContain('.ai-request-heading .secondary { width: 100%; }');
  });
});

describe('Automation Inbox processing guidance', () => {
  it('states that every new message is analyzed by AI without requiring a literal date format', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/automation']}>
        <Dashboard
          {...dashboardProps()}
          automation={{
            email: 'owner@example.com', displayName: 'Owner', enabled: true, status: 'active',
            lastSyncedAt: null, lastError: null, failingSince: null, created: 0, skipped: 0, exceptions: 0,
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('すべての新着メールを確認');
    expect(html).toContain('固定の日付書式は不要です');
    expect(html).not.toContain('2026/08/03 19:00-21:00');
    expect(html).not.toContain('書式不足');
  });

  it('reports a still-connected Inbox whose scheduled runs keep failing without asking for reauthentication', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/automation']}>
        <Dashboard
          {...dashboardProps()}
          automation={{
            email: 'owner@example.com', displayName: 'Owner', enabled: true, status: 'active',
            lastSyncedAt: '2026-08-01T00:00:00.000Z', lastError: 'Backend Error',
            failingSince: '2026-08-02T00:00:00.000Z', created: 0, skipped: 0, exceptions: 0,
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('自動処理に失敗しています');
    expect(html).toContain('Backend Error');
    expect(html).not.toContain('Google に再接続してください');
  });
});

describe('Operational Task Roles', () => {
  it('offers Organization role CRUD, assignments, historical role names, and an unassigned filter', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/tasks']}>
        <Dashboard
          {...dashboardProps()}
          page="tasks"
          taskRoles={[{ id: 'role-registration', displayName: '参加登録担当', description: '出欠と申込期限を扱う' }]}
          taskRoleAssignments={[{ roleId: 'role-registration', memberId: 'member-1', displayName: '山田' }]}
          taskMembers={[{ memberId: 'member-1', displayName: '山田' }]}
          organizationTasks={[{
            id: 'task-1', title: '登録状況を確認する', deadline: '2026-08-20',
            assigneeRoleId: 'role-registration', assigneeRoleName: '旧・参加登録担当',
            assigneeMemberId: 'member-1', assigneeName: 'Owner', sourceMessageSubject: '年次行事',
            description: '参加登録を取りまとめる', remarks: '', completed: false, completedAt: null,
          }]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('Operational Task Roleを追加');
    expect(html).toContain('参加登録担当');
    expect(html).toContain('出欠と申込期限を扱う');
    expect(html).toContain('名前と説明を編集');
    expect(html).toContain('roleを削除');
    expect(html).toContain('旧・参加登録担当');
    expect(html).toContain('<option value="unassigned">未割り当て</option>');
  });

  it('lets an Automation Rule select the Organization role subset it may assign', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/rules']}>
        <Dashboard
          {...dashboardProps()}
          page="rules"
          taskRoles={[
            { id: 'role-registration', displayName: '参加登録担当', description: '申込期限を扱う' },
            { id: 'role-payment', displayName: '支払担当', description: '支払期限を扱う' },
          ]}
          organizationRules={[{
            id: 'rule-1', organizationId: 'org-1', name: '登録案内', state: 'active',
            selectionPolicy: {}, routingPolicy: {}, taskRoleIds: ['role-registration'], priority: 0,
            permittedRecipientListIds: [], permittedLineListIds: [],
            createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
          }]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('割り当て可能なOperational Task Roles');
    expect(html).toContain('参加登録担当');
    expect(html).toContain('支払担当');
    expect(html).toContain('選択Role: 参加登録担当');
  });

  it('lets a member add and remove permitted destination lists in the Automation Rule editor', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/rules']}>
        <Dashboard
          {...dashboardProps()}
          page="rules"
          organizationLists={[
            { id: 'recipients-members', organizationId: 'org-1', kind: 'recipient', name: 'Members', description: '' },
            { id: 'recipients-guests', organizationId: 'org-1', kind: 'recipient', name: 'Guests', description: '' },
            { id: 'line-members', organizationId: 'org-1', kind: 'line', name: 'Member LINE', description: '' },
          ]}
          organizationRules={[{
            id: 'rule-1', organizationId: 'org-1', name: 'Announcements', state: 'active',
            selectionPolicy: {}, routingPolicy: {}, taskRoleIds: [],
            permittedRecipientListIds: ['recipients-members'],
            permittedLineListIds: ['line-members'],
            priority: 0, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
          }]}
          onUpdateRule={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('許可されたCalendar Recipient Lists');
    expect(html).toContain('許可されたLINE Destination Lists');
    expect(html).toContain('Members');
    expect(html).toContain('Guests');
    expect(html).toContain('Member LINE');
    expect(html).toContain('許可リストを編集');
    expect(html).toContain('選択中: Members');
    expect(html).toContain('選択中: Member LINE');
  });
});

describe('Preset settings', () => {
  it('requires an explicit choice before adding a Preset beside existing configuration', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/connections']}>
        <Dashboard
          {...dashboardProps()}
          page="connections"
          organizationLists={[{ id: 'existing', organizationId: 'org-1', kind: 'source', name: 'Existing', description: '' }]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('Membership organization');
    expect(html).toContain('既存の構成に別のコピーを追加する');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Presetを適用<\/button>/u);
  });
});

const saveFolderButton = (html: string): string => {
  const before = html.slice(0, html.indexOf('保存先を保存'));
  return before.slice(before.lastIndexOf('<button'));
};

describe('Attachment Folder Path', () => {
  it('shows the Drive location attachments are written to and disables saving an unchanged path', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/connections']}>
        <Dashboard {...dashboardProps()} page="connections" />
      </MemoryRouter>,
    );

    expect(html).toContain('添付ファイルの保存先');
    expect(html).toContain('現在: Mail Automation');
    expect(saveFolderButton(html)).toContain('disabled=""');
  });

  it('offers to save a path the Organization has changed', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/connections']}>
        <Dashboard {...dashboardProps()} page="connections" attachmentFolderPath="会計 2026/添付" />
      </MemoryRouter>,
    );

    expect(html).toContain('会計 2026/添付');
    expect(saveFolderButton(html)).not.toContain('disabled=""');
  });
});

describe('read-only Agent Rules', () => {
  it('offers Prompt and Agent Rule management and renders a readable Run Transcript', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/rules']}>
        <Dashboard
          {...dashboardProps()}
          page="rules"
          prompts={[{ id: 'prompt-1', organizationId: 'org-1', name: 'Analyst', instructions: 'Read carefully.', revision: 2, createdAt: '2026-08-01', updatedAt: '2026-08-02' }]}
          agentRules={[{ id: 'agent-rule-1', organizationId: 'org-1', name: 'Read-only analyst', promptId: 'prompt-1', state: 'active', executionMode: 'read_only', selectionPolicy: { domain: 'example.com' }, permittedRecipientListIds: [], permittedLineListIds: [], priority: 0, revision: 1, createdAt: '2026-08-01', updatedAt: '2026-08-01' }]}
          agentRuns={[{ id: 'run-1', agentRuleId: 'agent-rule-1', agentRuleRevision: 1, promptId: 'prompt-1', promptRevision: 2, sourceMessageId: 'source-1', model: 'test-model', startedAt: '2026-08-02', completedAt: '2026-08-02', outcome: 'succeeded', toolCallCount: 1, tokens: 42, expiresAt: '2026-10-31' }]}
          agentTranscript={{ runId: 'run-1', source: { subject: 'Confidential notice', body: 'Source transcript body', attachments: [] }, finalOutput: 'No action required.', messages: [], error: null }}
          proposedActions={[{ id: 'action-1', runId: 'run-1', tool: 'send_line_message', arguments: { destination: 'line-user-1', message: 'Notify.' }, status: 'pending', expiresAt: '2026-08-09' }]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('Promptを作成');
    expect(html).toContain('Read carefully.');
    expect(html).toContain('Promptを編集');
    expect(html).toContain('Promptを削除');
    expect(html).toContain('Agent Ruleを作成');
    expect(html).toContain('Read-only analyst');
    expect(html).toContain('Run Transcript');
    expect(html).toContain('Source transcript body');
    expect(html).toContain('No action required.');
    expect(html).toContain('Proposed Actions');
    expect(html).toContain('承認');
    expect(html).toContain('却下');
  });
});

describe('member roster', () => {
  it('shows discovered LINE identities next to editable member contact data', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/members']}>
        <Dashboard
          {...dashboardProps()}
          page="members"
          connections={{
            organizationId: 'org-1',
            organizationName: 'Example',
            ai: { apiKeyConfigured: false, model: '', baseUrl: '' },
            line: { channelAccessTokenConfigured: true, channelSecretConfigured: true, webhookUrl: 'https://app.example.com/api/public/organizations/org-1/line/webhook' },
          }}
          organizationMembers={[{
            id: 'recipient-1',
            organizationId: 'org-1',
            name: '山田 太郎',
            email: 'taro@example.com',
            state: 'active',
            tags: ['会員'],
            createdAt: '2026-07-30T00:00:00.000Z',
            updatedAt: '2026-07-30T00:00:00.000Z',
            lineDestinations: [{
              id: 'line-1',
              destinationId: 'U1234…',
              displayName: 'やまだ',
              kind: 'user',
              status: 'discovered',
              source: 'webhook',
            }],
          }]}
          lineDestinations={[{
            id: 'line-2',
            destinationId: 'U0987…',
            displayName: '鈴木 花子',
            kind: 'user',
            status: 'discovered',
            source: 'webhook',
            discoveredAt: '2026-07-30T00:00:00.000Z',
            memberId: null,
          }]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('メンバー管理');
    expect(html).toContain('鈴木 花子');
    expect(html).toContain('taro@example.com');
    expect(html).toContain('U1234…');
    expect(html).not.toContain('U1234567890');
    expect(html).toContain('メールアドレス（任意）');
    expect(html).toContain('後から設定できます');
    expect(html).toContain('LINEからメンバーを追加');
    expect(html).toContain('LINE IDを手動で登録');
    expect(html).toContain('本メンバーに登録');
    expect(html).toContain('保留中のLINE連絡先');
  });

  it('distinguishes a manually registered pending LINE contact from a webhook-discovered one in the pool', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/members']}>
        <Dashboard
          {...dashboardProps()}
          page="members"
          connections={{
            organizationId: 'org-1',
            organizationName: 'Example',
            ai: { apiKeyConfigured: false, model: '', baseUrl: '' },
            line: { channelAccessTokenConfigured: true, channelSecretConfigured: true, webhookUrl: 'https://app.example.com/api/public/organizations/org-1/line/webhook' },
          }}
          organizationMembers={[]}
          lineDestinations={[
            {
              id: 'line-webhook',
              destinationId: 'Uwebh…',
              displayName: '受信 太郎',
              kind: 'user',
              status: 'discovered',
              source: 'webhook',
              discoveredAt: '2026-07-30T00:00:00.000Z',
              memberId: null,
            },
            {
              id: 'line-manual-pending',
              destinationId: 'Upend…',
              displayName: '',
              kind: 'group',
              status: 'discovered',
              source: 'manual',
              discoveredAt: '2026-07-30T00:00:00.000Z',
              memberId: null,
            },
          ]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('個人・Webhook検出');
    expect(html).toContain('グループ・手動登録');
    expect(html).toContain('Upend…');
    expect(html).not.toContain('Upending000000000000000000000000000');
    expect(html).not.toContain('pending-line-empty');
  });

  it('marks a manually entered LINE Destination separately from a webhook-discovered one', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/members']}>
        <Dashboard
          {...dashboardProps()}
          page="members"
          connections={{
            organizationId: 'org-1',
            organizationName: 'Example',
            ai: { apiKeyConfigured: false, model: '', baseUrl: '' },
            line: { channelAccessTokenConfigured: true, channelSecretConfigured: true, webhookUrl: 'https://app.example.com/api/public/organizations/org-1/line/webhook' },
          }}
          organizationMembers={[{
            id: 'recipient-1',
            organizationId: 'org-1',
            name: '手動 花子',
            email: 'manual@example.com',
            state: 'active',
            tags: [],
            createdAt: '2026-07-30T00:00:00.000Z',
            updatedAt: '2026-07-30T00:00:00.000Z',
            lineDestinations: [{
              id: 'line-3',
              destinationId: 'Umanu…',
              displayName: '',
              kind: 'user',
              status: 'discovered',
              source: 'manual',
            }],
          }]}
          lineDestinations={[]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('手動 花子');
    expect(html).toContain('Umanu…');
    expect(html).not.toContain('Umanual00000000000000000000000000');
    expect(html).toContain('LINE 個人・手動');
  });

  it('stacks member controls and LINE identifiers on narrow screens', async () => {
    const stylesheet = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

    expect(stylesheet).toContain('.member-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(stylesheet).toContain('.member-create-form { grid-template-columns: minmax(0, 1fr); }');
    expect(stylesheet).toContain('.member-line-details code { grid-column: 1 / -1; grid-row: 2;');
    expect(stylesheet).toContain('.member-card { grid-template-columns: 40px minmax(0, 1fr); }');
    expect(stylesheet).toContain('.member-edit-button { grid-column: 2 / -1; grid-row: 3; justify-self: start; }');
  });
});

describe('mailbox test prerequisites', () => {
  it('allows Gmail search before an AI connection is configured', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/mailbox-test']}>
        <Dashboard
          {...dashboardProps()}
          page="mail-test"
          automation={{
            email: 'owner@example.com',
            displayName: 'Owner',
            enabled: true,
            status: 'active',
            lastSyncedAt: null,
            lastError: null,
            failingSince: null,
            created: 0,
            skipped: 0,
            exceptions: 0,
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toMatch(/<button class="primary">Gmailを検索<\/button>/u);
  });

  it('describes the prepared payload as usable with any OpenAI-compatible API', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/mailbox-test']}>
        <Dashboard
          {...dashboardProps()}
          page="mail-test"
          automation={{
            email: 'owner@example.com',
            displayName: 'Owner',
            enabled: true,
            status: 'active',
            lastSyncedAt: null,
            lastError: null,
            failingSince: null,
            created: 0,
            skipped: 0,
            exceptions: 0,
          }}
          mailTestAiRequest={{
            id: 'message-1',
            subject: '例会のお知らせ',
            sender: 'sender@example.com',
            request: { messages: [{ role: 'user', content: 'source' }] },
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('任意の OpenAI 互換 API');
    expect(html).toContain('OpenAI 互換 API が設定されていません');
    expect(html).toContain('href="/organizations/org-1/connections"');
    expect(html).toContain('APIを設定する');
  });

  it('uses provider-neutral wording when an AI API is configured', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/mailbox-test']}>
        <Dashboard
          {...dashboardProps()}
          page="mail-test"
          automation={{
            email: 'owner@example.com',
            displayName: 'Owner',
            enabled: true,
            status: 'active',
            lastSyncedAt: null,
            lastError: null,
            failingSince: null,
            created: 0,
            skipped: 0,
            exceptions: 0,
          }}
          connections={{
            organizationId: 'org-1',
            organizationName: 'Example',
            ai: {
              apiKeyConfigured: true,
              model: 'test-model',
              baseUrl: 'https://ai.example.com/v1',
            },
            line: { channelAccessTokenConfigured: false, channelSecretConfigured: false, webhookUrl: 'https://app.example.com/api/public/organizations/org-1/line/webhook' },
          }}
          mailTestAiRequest={{
            id: 'message-1',
            subject: '例会のお知らせ',
            sender: 'sender@example.com',
            request: { messages: [{ role: 'user', content: 'source' }] },
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('設定済みの API で予定を抽出');
    expect(html).not.toContain('APIを設定する');
  });

  it('shows the email summary returned with the AI extraction', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/mailbox-test']}>
        <Dashboard
          {...dashboardProps()}
          page="mail-test"
          automation={{
            email: 'owner@example.com', displayName: 'Owner', enabled: true, status: 'active',
            lastSyncedAt: null, lastError: null, failingSince: null, created: 0, skipped: 0, exceptions: 0,
          }}
          mailTestPreview={{
            id: 'message-1', subject: '例会のお知らせ', sender: 'sender@example.com',
            summary: '8月3日の例会案内です。7月31日までに出席登録が必要です。',
            events: [{
              title: '例会', startsAt: '2026-08-03T19:00:00+09:00', endsAt: '2026-08-03T21:00:00+09:00',
              timeZone: 'Asia/Tokyo', location: '会館', description: '月例会',
              summary: '毎月の例会です。会費は当日徴収します。',
            }],
            tasks: [], confirmationToken: 'token', expiresAt: '2026-08-03T00:00:00.000Z',
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('メールの要約');
    expect(html).toContain('8月3日の例会案内です。7月31日までに出席登録が必要です。');
    expect(html).toContain('毎月の例会です。会費は当日徴収します。');
  });

  it('configures an OpenAI-compatible endpoint without a fixed provider or model', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/connections']}>
        <Dashboard {...dashboardProps()} page="connections" />
      </MemoryRouter>,
    );

    expect(html).toContain('OpenAI 互換 API');
    expect(html).toContain('Base URL');
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain('placeholder="例: gpt-4.1-mini"');
  });

  it('lets each external connection be saved independently', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/connections']}>
        <Dashboard
          {...dashboardProps()}
          page="connections"
          lineChannelAccessToken="line-token"
          lineChannelSecret="line-secret"
          aiApiKey=""
          aiModel=""
          aiBaseUrl=""
        />
      </MemoryRouter>,
    );

    expect(html).toMatch(/<button[^>]*>.*?LINE設定を保存<\/button>/su);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?AI設定を保存<\/button>/su);
    expect(html).not.toContain('接続設定を保存');
  });

  it('shows a copyable LINE webhook URL and its setup instructions', () => {
    const webhookUrl = 'https://app.example.com/api/public/organizations/org-1/line/webhook';
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/organizations/org-1/connections']}>
        <Dashboard
          {...dashboardProps()}
          page="connections"
          connections={{
            organizationId: 'org-1',
            organizationName: 'Example',
            ai: { apiKeyConfigured: false, model: '', baseUrl: '' },
            line: {
              channelAccessTokenConfigured: true,
              channelSecretConfigured: true,
              webhookUrl,
            },
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('Webhook URL');
    expect(html).toContain(`value="${webhookUrl}"`);
    expect(html).toContain('aria-label="Webhook URLをコピー"');
    expect(html).toContain('LINE Developers');
    expect(html).toContain('Webhookの利用をオン');
    expect(html).toContain('保留中のLINE連絡先');
  });
});

describe('AI Task reassignment', () => {
  const tasksMarkup = (props: Partial<DashboardProps>): string => renderToStaticMarkup(
    <MemoryRouter initialEntries={['/organizations/org-1/tasks']}>
      <Dashboard
        {...dashboardProps()}
        page="tasks"
        taskRoles={[
          { id: 'role-registration', displayName: '参加登録担当', description: '出欠期限を扱う' },
          { id: 'role-payment', displayName: '会計担当', description: '支払期限を扱う' },
        ]}
        {...props}
      />
    </MemoryRouter>,
  );

  it('keeps the reassignment action disabled until an Operational Task Role changes', () => {
    const html = tasksMarkup({ taskReassignment: { rolesChangedAt: null, reviewedAt: null, pending: false, openTasks: 3 } });

    expect(html).toContain('AIでタスクを再割り当て');
    expect(html).toContain('roleを追加・変更・削除すると、未完了タスクの割り当て案をAIに出させられます。');
    expect(/AIに割り当て案を出させる/u.test(html)).toBe(true);
    expect(/<button type="button" class="primary" disabled="">AIに割り当て案を出させる<\/button>/u.test(html)).toBe(true);
  });

  it('enables the reassignment action once a changed role leaves open Tasks to review', () => {
    const html = tasksMarkup({
      taskReassignment: { rolesChangedAt: '2026-08-04T00:00:00.000Z', reviewedAt: null, pending: true, openTasks: 2 },
    });

    expect(html).toContain('未完了タスク2件の割り当て案をAIに出させられます。');
    expect(/<button type="button" class="primary" disabled="">AIに割り当て案を出させる<\/button>/u.test(html)).toBe(false);
  });

  it('offers no reassignment when the changed roles leave nothing open to review', () => {
    const html = tasksMarkup({
      taskReassignment: { rolesChangedAt: '2026-08-04T00:00:00.000Z', reviewedAt: null, pending: true, openTasks: 0 },
    });

    expect(/<button type="button" class="primary" disabled="">AIに割り当て案を出させる<\/button>/u.test(html)).toBe(true);
  });

  it('shows each proposed role with its reason and preselects only the Tasks that would move', () => {
    const html = tasksMarkup({
      taskReassignment: { rolesChangedAt: '2026-08-04T00:00:00.000Z', reviewedAt: null, pending: true, openTasks: 2 },
      taskReassignmentProposals: [
        {
          taskId: 'task-1', title: '参加費を支払う', deadline: '2026-08-25', sourceMessageSubject: '総会案内',
          currentRoleId: 'role-registration', currentRoleName: '参加登録担当',
          proposedRoleId: 'role-payment', proposedRoleName: '会計担当',
          reason: '送金の期限だから', changed: true,
        },
        {
          taskId: 'task-2', title: '出欠を回答する', deadline: '2026-08-20', sourceMessageSubject: '総会案内',
          currentRoleId: 'role-registration', currentRoleName: '参加登録担当',
          proposedRoleId: 'role-registration', proposedRoleName: '参加登録担当',
          reason: '出欠の期限だから', changed: false,
        },
      ],
    });

    expect(html).toContain('2件のうち1件のroleを変更する案です。');
    expect(html).toContain('送金の期限だから');
    expect(html).toContain('（変更なし）');
    expect(html).toContain('aria-label="参加費を支払うを会計担当に割り当てる"');
    expect(html).toContain('選んだ1件を適用');
    expect(html).toContain('この案を破棄');
  });
});

describe('operation progress', () => {
  const pendingOnly = (...keys: string[]): DashboardProps['isPending'] => (key: string) => keys.includes(key);
  const dashboard = (props: Partial<DashboardProps>, page: NonNullable<DashboardProps['page']>, path = 'automation'): string =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/organizations/org-1/${path}`]}>
        <Dashboard {...dashboardProps()} page={page} {...props} />
      </MemoryRouter>,
    );

  it('reports a running mailbox scan on its own control and leaves the switch usable', () => {
    const automation = {
      email: 'owner@example.com', displayName: 'Owner', enabled: true, status: 'active' as const,
      lastSyncedAt: null, lastError: null, failingSince: null, created: 0, skipped: 0, exceptions: 0,
    };
    const html = dashboard({ automation, isPending: pendingOnly(pendingKey.automationRun) }, 'automation');

    expect(html).toContain('メールを確認中…');
    expect(html).toContain('class="lucide lucide-refresh-cw spin"');
    expect(html).not.toContain('切替中…');
  });

  it('reports an automation switch that is still being toggled', () => {
    const automation = {
      email: 'owner@example.com', displayName: 'Owner', enabled: false, status: 'active' as const,
      lastSyncedAt: null, lastError: null, failingSince: null, created: 0, skipped: 0, exceptions: 0,
    };
    const html = dashboard({ automation, isPending: pendingOnly(pendingKey.automationEnabled) }, 'automation');

    expect(html).toContain('切替中…');
    expect(html).not.toContain('メールを確認中…');
  });

  it('never lends one Prompt’s progress to another control', () => {
    const prompts = [
      { id: 'prompt-1', organizationId: 'org-1', name: '案内', instructions: '読む', revision: 1, createdAt: '', updatedAt: '' },
      { id: 'prompt-2', organizationId: 'org-1', name: '請求', instructions: '読む', revision: 1, createdAt: '', updatedAt: '' },
    ];
    const html = dashboard({ prompts, isPending: pendingOnly(pendingKey.promptUpdate('prompt-1')) }, 'rules', 'rules');

    expect(html.match(/保存中…/gu)?.length).toBe(2);
    expect(html).toContain('ルールを作成');
    expect(html).not.toContain('>作成中…');
    expect(html).toContain('Promptを削除');
  });

  it('reports a Proposed Action decision on the action being decided', () => {
    const html = dashboard({
      agentTranscript: { runId: 'run-1', source: { subject: '案内', body: '', attachments: [] }, messages: [], finalOutput: '', error: null },
      proposedActions: [
        { id: 'action-1', runId: 'run-1', tool: 'send_line_message', arguments: {}, status: 'pending', expiresAt: '2026-08-05' },
        { id: 'action-2', runId: 'run-1', tool: 'send_line_message', arguments: {}, status: 'pending', expiresAt: '2026-08-05' },
      ],
      isPending: pendingOnly(pendingKey.actionDecision('action-1', 'approve')),
    }, 'rules', 'rules');

    expect(html.match(/承認中…/gu)?.length).toBe(1);
    expect(html).not.toContain('却下中…');
    expect(html).toContain('すべて承認');
  });

  it('reports the one mail whose request is being prepared', () => {
    const html = dashboard({
      automation: {
        email: 'owner@example.com', displayName: 'Owner', enabled: true, status: 'active',
        lastSyncedAt: null, lastError: null, failingSince: null, created: 0, skipped: 0, exceptions: 0,
      },
      mailTestMatches: [
        { id: 'message-1', subject: '総会案内', sender: 'sender@example.com' },
        { id: 'message-2', subject: '請求案内', sender: 'sender@example.com' },
      ],
      isPending: pendingOnly(pendingKey.mailPrepare('message-1')),
    }, 'mail-test', 'mailbox-test');

    expect(html.match(/本文と添付を読み込み中…/gu)?.length).toBe(1);
    expect(html).toContain('Gmailを検索');
    expect(html).not.toContain('検索中…');
  });

  it('reports a saved AI connection after the save finishes', () => {
    const connections = {
      organizationId: 'org-1', organizationName: 'Example',
      line: { channelAccessTokenConfigured: false, channelSecretConfigured: false, webhookUrl: 'https://app.example.com/hook' },
      ai: { apiKeyConfigured: true, model: 'test-model', baseUrl: 'https://ai.example.com/v1' },
    };
    const saving = dashboard({ connections, isPending: pendingOnly(pendingKey.aiConnection) }, 'connections', 'connections');
    const saved = dashboard({ connections, isSettled: (key: string) => key === pendingKey.aiConnection }, 'connections', 'connections');

    expect(saving).toContain('保存中…');
    expect(saved).toContain('保存しました');
  });

  it('reports the Task whose row is being written, not the whole table', () => {
    const task = (id: string, title: string) => ({
      id, title, deadline: '2026-08-20', assigneeRoleId: 'role-1', assigneeRoleName: '会計担当',
      assigneeMemberId: 'member-1', assigneeName: '山田', sourceMessageSubject: '総会案内',
      description: '', remarks: '', completed: false, completedAt: null,
    });
    const html = dashboard({
      organizationTasks: [task('task-1', '参加費を支払う'), task('task-2', '出欠を回答する')],
      isPending: pendingOnly(pendingKey.taskUpdate('task-1')),
    }, 'tasks', 'tasks');

    expect(html.match(/保存中…/gu)?.length).toBe(1);
    expect(html).toContain('aria-busy="true"');
  });

  it('reports an AI reassignment that is still being judged, and the Tasks it could not move', () => {
    const judging = dashboard({
      taskReassignment: { rolesChangedAt: '2026-08-04T00:00:00.000Z', reviewedAt: null, pending: true, openTasks: 4 },
      isPending: pendingOnly(pendingKey.reassignmentSuggest),
    }, 'tasks', 'tasks');
    const skipped = dashboard({
      taskReassignmentSkipped: ['task-1'],
      organizationTasks: [{
        id: 'task-1', title: '参加費を支払う', deadline: '2026-08-20', assigneeRoleId: 'role-1', assigneeRoleName: '会計担当',
        assigneeMemberId: null, assigneeName: '未割り当て', sourceMessageSubject: '総会案内',
        description: '', remarks: '', completed: false, completedAt: null,
      }],
    }, 'tasks', 'tasks');

    expect(judging).toContain('未完了タスク4件をAIが判定中…');
    expect(judging).toContain('AIの応答を待っています');
    expect(skipped).toContain('1件は適用できませんでした');
    expect(skipped).toContain('参加費を支払う');
  });

  it('names the running operation in the middle of the page, whatever is scrolled into view', () => {
    const html = dashboard({ runningOperations: [pendingKey.mailSearch] }, 'mail-test', 'mailbox-test');

    expect(html).toContain('class="pending-overlay"');
    expect(html).toContain('Gmail を検索しています');
    expect(html).toContain('完了するまでこのページを開いたままにしてください。');
    expect(dashboard({}, 'mail-test', 'mailbox-test')).not.toContain('pending-overlay');
  });

  it('counts the other operations running behind the one it names', () => {
    const html = dashboard({
      runningOperations: [pendingKey.taskUpdate('task-1'), pendingKey.taskRoleAssign('role-1')],
    }, 'tasks', 'tasks');

    expect(html).toContain('タスクを保存しています');
    expect(html).toContain('ほか1件の処理を実行中です');
  });

  it('dims the stale page while the route it navigated to is still loading', () => {
    const html = dashboard({ navigating: true }, 'automation');

    expect(html).toContain('class="app-content navigating"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('ページを読み込んでいます');
    expect(dashboard({}, 'automation')).toContain('class="app-content"');
  });

  it('reports the member whose card is being saved and the roster refresh separately', () => {
    const member = (id: string, name: string) => ({
      id, organizationId: 'org-1', name, email: '', state: 'active' as const, tags: [],
      createdAt: '', updatedAt: '', lineDestinations: [],
    });
    const html = dashboard({
      organizationMembers: [member('member-1', '山田'), member('member-2', '鈴木')],
      isPending: pendingOnly(pendingKey.memberRefresh),
    }, 'members', 'members');

    expect(html).toContain('更新中…');
    expect(html).not.toContain('登録中…');
  });
});

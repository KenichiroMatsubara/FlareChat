import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Dashboard, GoogleReauthenticationAction, NAVIGATION_PANEL_ID, needsGoogleReauthentication, type DashboardProps } from './dashboard';

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
  page: 'automation', automation: null, summary: null, busy: false, error: '',
  onRun: vi.fn(), onSetEnabled: vi.fn(), onLogout: vi.fn(), onReauthenticate: vi.fn(),
  organization: { name: 'Example', role: 'owner' }, organizationId: 'org-1',
  organizations: [{ organizationId: 'org-1', name: 'Example', role: 'owner', status: 'active' }],
  canManage: true, connections: null, lineChannelAccessToken: '', lineChannelSecret: '', aiApiKey: '', aiModel: 'test-model', aiBaseUrl: 'https://ai.example.com/v1',
  onLineChannelAccessTokenChange: vi.fn(), onLineChannelSecretChange: vi.fn(), onAiApiKeyChange: vi.fn(), onAiModelChange: vi.fn(), onAiBaseUrlChange: vi.fn(),
  settingsBusy: false, onSaveConnections: vi.fn(), aiTestPrompt: '', aiTestResult: '', aiTestBusy: false,
  onAiTestPromptChange: vi.fn(), onTestAi: vi.fn(), mailTestSubject: '', mailTestMatches: [], mailTestAiRequest: null,
  mailTestPreview: null, mailTestBusy: false, mailTestCreatedEventIds: [], onMailTestSubjectChange: vi.fn(), onSearchMailbox: vi.fn(),
  onPrepareMailbox: vi.fn(), onPreviewMailbox: vi.fn(), onCreateCalendarEvent: vi.fn(), organizationRules: [], ruleBusy: false,
  onCreateRule: vi.fn(), organizationTasks: [], onUpdateTask: vi.fn(), taskRoleAssignments: [], taskMembers: [], onAssignTaskRole: vi.fn(),
  organizationRecipients: [], lineDestinations: [], memberBusy: false, onCreateRecipient: vi.fn(), onUpdateRecipient: vi.fn(),
  onSetLineDestination: vi.fn(), onUnlinkLineDestination: vi.fn(), onRefreshRecipients: vi.fn(),
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
            line: { channelAccessTokenConfigured: true, channelSecretConfigured: true },
          }}
          organizationRecipients={[{
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
              destinationId: 'U1234567890',
              displayName: 'やまだ',
              kind: 'user',
              status: 'discovered',
              source: 'webhook',
            }],
          }]}
          lineDestinations={[{
            id: 'line-2',
            destinationId: 'U0987654321',
            displayName: '鈴木 花子',
            kind: 'user',
            status: 'discovered',
            source: 'webhook',
            discoveredAt: '2026-07-30T00:00:00.000Z',
            recipientProfileId: null,
          }]}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('メンバー管理');
    expect(html).toContain('鈴木 花子');
    expect(html).toContain('taro@example.com');
    expect(html).toContain('U1234567890');
    expect(html).toContain('LINEからメンバーを追加');
    expect(html).toContain('LINE IDを手動で入力');
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
            line: { channelAccessTokenConfigured: true, channelSecretConfigured: true },
          }}
          organizationRecipients={[{
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
              destinationId: 'Umanual00000000000000000000000000',
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
    expect(html).toContain('Umanual00000000000000000000000000');
    expect(html).toContain('LINE 個人・手動');
  });

  it('stacks member controls and LINE identifiers on narrow screens', async () => {
    const stylesheet = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

    expect(stylesheet).toContain('.member-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }');
    expect(stylesheet).toContain('.member-create-form { grid-template-columns: minmax(0, 1fr); }');
    expect(stylesheet).toContain('.member-line-details code { grid-column: 1 / 3; grid-row: 2;');
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
            line: { channelAccessTokenConfigured: false, channelSecretConfigured: false },
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
});

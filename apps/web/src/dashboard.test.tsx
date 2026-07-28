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
  canManage: true, connections: null, lineChannelAccessToken: '', lineChannelSecret: '', geminiApiKey: '', aiModel: 'gemini-3.5-flash-lite',
  onLineChannelAccessTokenChange: vi.fn(), onLineChannelSecretChange: vi.fn(), onGeminiApiKeyChange: vi.fn(), onAiModelChange: vi.fn(),
  settingsBusy: false, onSaveConnections: vi.fn(), geminiTestPrompt: '', geminiTestResult: '', geminiTestBusy: false,
  onGeminiTestPromptChange: vi.fn(), onTestGemini: vi.fn(), mailTestSubject: '', mailTestMatches: [], mailTestGeminiRequest: null,
  mailTestPreview: null, mailTestBusy: false, mailTestCreatedEventIds: [], onMailTestSubjectChange: vi.fn(), onSearchMailbox: vi.fn(),
  onPrepareMailbox: vi.fn(), onPreviewMailbox: vi.fn(), onCreateCalendarEvent: vi.fn(), organizationRules: [], ruleBusy: false,
  onCreateRule: vi.fn(), organizationTasks: [], onUpdateTask: vi.fn(), taskRoleAssignments: [], taskMembers: [], onAssignTaskRole: vi.fn(),
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
    for (const label of ['自動化', '接続設定', 'ルール', 'タスク', 'メールテスト', 'ログアウト']) expect(panel).toContain(label);
  });
});

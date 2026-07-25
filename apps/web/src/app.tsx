import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  CircleCheck,
  Clock3,
  Inbox,
  LayoutDashboard,
  ListFilter,
  Menu,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type {
  AutomationRule,
  Dashboard,
  ListKind,
  Organization,
  ScheduledEvent,
  TypedList,
} from '@mail/domain';

import { api } from './api';
import type { ExceptionRow } from './api';
import { Lists } from './lists';
import { Modal } from './modal';
import { Rules } from './rules';

type Page = 'dashboard' | 'lists' | 'rules' | 'events' | 'exceptions' | 'settings';

const navigation: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '概要', icon: LayoutDashboard },
  { id: 'lists', label: 'リスト', icon: ListFilter },
  { id: 'rules', label: '自動化ルール', icon: Workflow },
  { id: 'events', label: '予定・参加状況', icon: CalendarDays },
  { id: 'exceptions', label: '要確認', icon: AlertTriangle },
  { id: 'settings', label: '接続設定', icon: Settings },
];

export const App = () => {
  const [page, setPage] = useState<Page>('dashboard');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [lists, setLists] = useState<TypedList[]>([]);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [error, setError] = useState('');

  const loadOrganizations = useCallback(async () => {
    try {
      const result = await api.organizations();
      setOrganizations(result);
      setOrganizationId((current) => current || result[0]?.id || '');
      if (result.length === 0) setSetupOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '組織を取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadData = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    try {
      const [nextDashboard, nextLists, nextRules, nextEvents, nextExceptions] =
        await Promise.all([
          api.dashboard(organizationId),
          api.lists(organizationId),
          api.rules(organizationId),
          api.events(organizationId),
          api.exceptions(),
        ]);
      setDashboard(nextDashboard);
      setLists(nextLists);
      setRules(nextRules);
      setEvents(nextEvents);
      setExceptions(nextExceptions);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'データを取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void loadOrganizations();
  }, [loadOrganizations]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const runAutomation = async () => {
    if (!organizationId) return;
    setRunning(true);
    try {
      await api.run(organizationId);
      setTimeout(() => void loadData(), 900);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '実行を開始できませんでした。');
    } finally {
      setRunning(false);
    }
  };

  const activeOrganization = organizations.find((item) => item.id === organizationId);

  return (
    <div className="shell">
      <aside className={sidebar ? 'sidebar sidebar-open' : 'sidebar'}>
        <div className="brand">
          <div className="brand-mark"><Inbox size={21} /></div>
          <div><strong>Postman</strong><span>MAIL AUTOMATION</span></div>
          <button className="mobile-close" onClick={() => setSidebar(false)} aria-label="閉じる">
            <X size={20} />
          </button>
        </div>
        <nav>
          <p className="nav-label">運用</p>
          {navigation.slice(0, 5).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => { setPage(item.id); setSidebar(false); }}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === 'exceptions' && exceptions.length > 0 && (
                <b className="nav-count">{exceptions.length}</b>
              )}
            </button>
          ))}
          <p className="nav-label nav-space">管理</p>
          {navigation.slice(5).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => { setPage(item.id); setSidebar(false); }}
            >
              <item.icon size={18} /><span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className="live-dot" />
          <div><strong>自動実行中</strong><small>1分ごとに確認</small></div>
        </div>
      </aside>

      <main>
        <header>
          <button className="menu-button" onClick={() => setSidebar(true)} aria-label="メニュー">
            <Menu size={22} />
          </button>
          <button className="organization-switch" onClick={() => setSetupOpen(true)}>
            <span className="organization-avatar">
              {(activeOrganization?.name ?? '組').slice(0, 1)}
            </span>
            <span><strong>{activeOrganization?.name ?? '組織を設定'}</strong><small>{activeOrganization?.inboxAddress}</small></span>
            <ChevronDown size={16} />
          </button>
          <div className="header-actions">
            <button className="secondary icon-button" onClick={() => void loadData()} title="更新">
              <RefreshCw size={17} className={loading ? 'spin' : ''} />
            </button>
            <button className="primary" disabled={!organizationId || running} onClick={() => void runAutomation()}>
              <Play size={16} fill="currentColor" />
              {running ? '開始中…' : '今すぐ確認'}
            </button>
          </div>
        </header>

        <section className="content">
          {error && <div className="error-banner"><AlertTriangle size={18} />{error}<button onClick={() => setError('')}><X size={16} /></button></div>}
          {page === 'dashboard' && <DashboardView dashboard={dashboard} loading={loading} onNavigate={setPage} />}
          {page === 'lists' && organizationId && (
            <Lists organizationId={organizationId} lists={lists} onChange={() => void loadData()} />
          )}
          {page === 'rules' && organizationId && (
            <Rules organizationId={organizationId} rules={rules} lists={lists} onChange={() => void loadData()} />
          )}
          {page === 'events' && <Events events={events} />}
          {page === 'exceptions' && <Exceptions rows={exceptions} />}
          {page === 'settings' && <Connections organization={activeOrganization} />}
        </section>
      </main>

      <OrganizationModal
        open={setupOpen}
        organizations={organizations}
        onClose={() => setSetupOpen(false)}
        onSelect={(id) => { setOrganizationId(id); setSetupOpen(false); }}
        onCreated={async (organization) => {
          setOrganizations((current) => [...current, organization]);
          setOrganizationId(organization.id);
          setSetupOpen(false);
        }}
      />
    </div>
  );
};

const DashboardView = ({
  dashboard,
  loading,
  onNavigate,
}: {
  dashboard: Dashboard | null;
  loading: boolean;
  onNavigate: (page: Page) => void;
}) => (
  <>
    <div className="page-heading">
      <div><p className="eyebrow">OVERVIEW</p><h1>おはようございます</h1><p>メールから予定への流れを、ここでまとめて確認できます。</p></div>
      {dashboard?.lastSyncAt && <span className="last-sync"><CircleCheck size={15} />最終確認 {formatRelative(dashboard.lastSyncAt)}</span>}
    </div>
    <div className="metrics">
      <Metric icon={Workflow} label="稼働中のルール" value={dashboard?.activeRules ?? 0} tone="green" />
      <Metric icon={CalendarDays} label="今後の予定" value={dashboard?.upcomingEvents ?? 0} tone="blue" />
      <Metric icon={Clock3} label="処理待ち" value={dashboard?.pendingJobs ?? 0} tone="amber" />
      <Metric icon={AlertTriangle} label="要確認" value={dashboard?.exceptions ?? 0} tone="red" />
    </div>
    <div className="dashboard-grid">
      <section className="panel">
        <div className="panel-title"><div><h2>最近の予定</h2><p>自動作成・更新された予定</p></div><button className="text-button" onClick={() => onNavigate('events')}>すべて見る</button></div>
        {loading ? <Loading /> : <EventRows events={dashboard?.events ?? []} />}
      </section>
      <section className="panel quick-panel">
        <div className="panel-title"><div><h2>はじめに</h2><p>自動化を動かす3ステップ</p></div></div>
        <Quick number="1" title="送信元を登録" text="案内メールを送る相手をリストに追加" done />
        <Quick number="2" title="会員を登録" text="予定を共有するGmailアドレスを追加" done={false} />
        <Quick number="3" title="ルールを有効化" text="対象と配信先を選んで自動実行" done={false} />
      </section>
    </div>
  </>
);

const Metric = ({ icon: Icon, label, value, tone }: { icon: typeof Workflow; label: string; value: number; tone: string }) => (
  <article className="metric"><span className={`metric-icon ${tone}`}><Icon size={20} /></span><div><strong>{value}</strong><span>{label}</span></div></article>
);

const Quick = ({ number, title, text, done }: { number: string; title: string; text: string; done: boolean }) => (
  <div className="quick-row"><span className={done ? 'quick-number done' : 'quick-number'}>{done ? <CircleCheck size={17} /> : number}</span><div><strong>{title}</strong><p>{text}</p></div></div>
);

const Events = ({ events }: { events: ScheduledEvent[] }) => (
  <>
    <PageHeading eyebrow="EVENTS" title="予定・参加状況" description="カレンダーへ共有した予定と、会員の回答を確認します。" />
    <section className="panel"><EventRows events={events} detailed /></section>
  </>
);

const EventRows = ({ events, detailed = false }: { events: ScheduledEvent[]; detailed?: boolean }) => {
  if (events.length === 0) return <Empty icon={CalendarDays} title="予定はまだありません" text="メールを取得すると、作成された予定がここに表示されます。" />;
  return <div className="event-list">{events.map((event) => (
    <div className="event-row" key={event.id}>
      <div className="date-block"><strong>{new Date(event.startsAt).getDate()}</strong><span>{new Intl.DateTimeFormat('ja-JP', { month: 'short' }).format(new Date(event.startsAt))}</span></div>
      <div className="event-main"><strong>{event.title}</strong><p>{formatDate(event.startsAt)} · {event.location || '場所未設定'}</p>{detailed && <small>元メール: {event.sourceSubject || '—'}</small>}</div>
      <div className="attendance-bars"><span className="attending"><Users size={14} />{event.attending}</span><span className="declined">不参加 {event.notAttending}</span><span>未回答 {event.unanswered}</span></div>
      <span className={`status ${event.status}`}>{statusLabel(event.status)}</span>
    </div>
  ))}</div>;
};

const Exceptions = ({ rows }: { rows: ExceptionRow[] }) => (
  <>
    <PageHeading eyebrow="REVIEW" title="要確認" description="自動処理できなかったメールだけを確認します。" />
    <section className="panel">
      {rows.length === 0 ? <Empty icon={CircleCheck} title="確認が必要な項目はありません" text="自動化は問題なく動いています。" /> :
        rows.map((row) => <div className="exception-row" key={row.id}><span><AlertTriangle size={18} /></span><div><strong>{row.message}</strong><p>{row.code} · {formatDate(row.created_at)}</p></div><button className="secondary">確認する</button></div>)}
    </section>
  </>
);

const Connections = ({ organization }: { organization: Organization | undefined }) => (
  <>
    <PageHeading eyebrow="CONNECTIONS" title="接続設定" description="自動化に使う外部サービスを管理します。" />
    <div className="connection-grid">
      <Connection icon={Inbox} name="Google Workspace" description={organization?.inboxAddress ?? '未接続'} connected={Boolean(organization)} />
      <Connection icon={Radio} name="LINE Messaging API" description="チャンネルと送信先を接続" connected={false} />
      <Connection icon={Workflow} name="AI抽出" description="予定の日時・場所・締切を抽出" connected={false} />
    </div>
  </>
);

const Connection = ({ icon: Icon, name, description, connected }: { icon: typeof Inbox; name: string; description: string; connected: boolean }) => (
  <article className="connection-card"><span className="connection-icon"><Icon size={23} /></span><div><strong>{name}</strong><p>{description}</p></div><button className={connected ? 'connection-state connected' : 'secondary'}>{connected ? '接続済み' : '接続する'}</button></article>
);

const OrganizationModal = ({ open, organizations, onClose, onSelect, onCreated }: {
  open: boolean; organizations: Organization[]; onClose: () => void; onSelect: (id: string) => void; onCreated: (organization: Organization) => void;
}) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { onCreated(await api.createOrganization(name, email)); }
    finally { setBusy(false); }
  };
  return <Modal open={open} onClose={organizations.length ? onClose : undefined} title={creating ? '組織を作成' : '組織を選択'}>
    {!creating ? <div className="organization-list">
      {organizations.map((organization) => <button key={organization.id} onClick={() => onSelect(organization.id)}><span className="organization-avatar">{organization.name.slice(0, 1)}</span><span><strong>{organization.name}</strong><small>{organization.inboxAddress}</small></span><CircleCheck size={18} /></button>)}
      <button className="create-organization" onClick={() => setCreating(true)}><Plus size={18} />新しい組織を作成</button>
    </div> : <form onSubmit={(event) => void submit(event)} className="form-stack">
      <label>組織名<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例: 岡崎ローターアクトクラブ" required /></label>
      <label>自動化用Gmail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="okazaki.rac@gmail.com" required /></label>
      <p className="form-note">このアドレスに届くメールだけを読みます。会員のGmailへのアクセス権限は要求しません。</p>
      <div className="modal-actions"><button type="button" className="secondary" onClick={() => setCreating(false)}>戻る</button><button className="primary" disabled={busy}>{busy ? '作成中…' : '作成する'}</button></div>
    </form>}
  </Modal>;
};

export const PageHeading = ({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) => (
  <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>
);

export const Empty = ({ icon: Icon, title, text }: { icon: typeof CalendarDays; title: string; text: string }) => (
  <div className="empty"><span><Icon size={24} /></span><strong>{title}</strong><p>{text}</p></div>
);

const Loading = () => <div className="loading"><RefreshCw className="spin" size={21} />読み込み中</div>;
const statusLabel = (status: ScheduledEvent['status']) => ({ draft: '下書き', scheduled: '共有済み', cancelled: '中止', exception: '要確認' })[status];
const formatDate = (value: string) => new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const formatRelative = (value: string) => new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

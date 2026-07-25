import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type {
  AutomationRule,
  Dashboard,
  ListItem,
  ListKind,
  Organization,
  ScheduledEvent,
  TypedList,
} from '@mail/domain';
import type { Bindings, CountRow, EventRow, ListRow, RuleRow, SettingRow } from './types';

import { failure, json } from './response';
import { toEvent, toList, toRule } from './rows';

interface OrganizationRow {
  id: string;
  name: string;
  inbox_address: string;
  status: 'provisioning' | 'active' | 'suspended' | 'failed';
  created_at: string;
}

interface ListItemRow {
  id: string;
  list_id: string;
  value: string;
  label: string;
  enabled: number;
}

interface ListInput {
  organizationId: string;
  kind: ListKind;
  name: string;
  description?: string;
}

interface ItemInput {
  value: string;
  label?: string;
}

interface RuleInput {
  organizationId: string;
  name: string;
  status?: AutomationRule['status'];
  sourceListId?: string | null;
  recipientListId?: string | null;
  lineListId?: string | null;
  scheduleMinutes?: number;
  requireAttendance?: boolean;
  deadlineDaysBefore?: number | null;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('/api/*', cors({ origin: ['http://localhost:5173'], credentials: true }));

app.get('/api/health', (context) =>
  json(context, { status: 'ok', service: 'mail-automation', time: new Date().toISOString() }),
);

app.get('/api/organizations', async (context) => {
  const result = await context.env.CONTROL_DB.prepare(
    'SELECT id, name, inbox_address, status, created_at FROM organizations ORDER BY created_at',
  ).all<OrganizationRow>();
  const organizations: Organization[] = result.results.map((row) => ({
    id: row.id,
    name: row.name,
    inboxAddress: row.inbox_address,
    status: row.status,
    createdAt: row.created_at,
  }));
  return json(context, organizations);
});

app.post('/api/organizations', async (context) => {
  const input = await context.req.json<{ name?: string; inboxAddress?: string }>();
  if (!input.name?.trim() || !input.inboxAddress?.trim()) {
    return failure(context, '組織名と自動化用Gmailアドレスを入力してください。');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.CONTROL_DB.prepare(
    `INSERT INTO organizations
      (id, name, inbox_address, status, binding_name, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 'ORG_DB', ?, ?)`,
  )
    .bind(id, input.name.trim(), input.inboxAddress.trim().toLowerCase(), now, now)
    .run();

  const organization: Organization = {
    id,
    name: input.name.trim(),
    inboxAddress: input.inboxAddress.trim().toLowerCase(),
    status: 'active',
    createdAt: now,
  };
  return json(context, organization, 201);
});

app.get('/api/dashboard/:organizationId', async (context) => {
  const organizationId = context.req.param('organizationId');
  const now = new Date().toISOString();
  const [rules, events, jobs, exceptions, recentEvents, sync] = await Promise.all([
    context.env.ORG_DB.prepare(
      "SELECT COUNT(*) AS count FROM rules WHERE organization_id = ? AND status = 'active'",
    )
      .bind(organizationId)
      .first<CountRow>(),
    context.env.ORG_DB.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE organization_id = ? AND status = 'scheduled' AND starts_at >= ?",
    )
      .bind(organizationId, now)
      .first<CountRow>(),
    context.env.ORG_DB.prepare("SELECT COUNT(*) AS count FROM jobs WHERE state = 'pending'").first<
      CountRow
    >(),
    context.env.ORG_DB.prepare(
      "SELECT COUNT(*) AS count FROM exceptions WHERE state = 'open'",
    ).first<CountRow>(),
    eventQuery(context.env.ORG_DB, organizationId, 5),
    context.env.ORG_DB.prepare("SELECT value FROM settings WHERE key = 'last_sync_at'").first<
      SettingRow
    >(),
  ]);

  const dashboard: Dashboard = {
    activeRules: rules?.count ?? 0,
    upcomingEvents: events?.count ?? 0,
    pendingJobs: jobs?.count ?? 0,
    exceptions: exceptions?.count ?? 0,
    lastSyncAt: sync?.value ?? null,
    events: recentEvents,
  };
  return json(context, dashboard);
});

app.get('/api/lists/:organizationId', async (context) => {
  const result = await context.env.ORG_DB.prepare(
    `SELECT l.*, COUNT(i.id) AS item_count
     FROM lists l LEFT JOIN list_items i ON i.list_id = l.id
     WHERE l.organization_id = ?
     GROUP BY l.id ORDER BY l.kind, l.name`,
  )
    .bind(context.req.param('organizationId'))
    .all<ListRow>();
  return json(context, result.results.map(toList));
});

app.post('/api/lists', async (context) => {
  const input = await context.req.json<ListInput>();
  if (!input.organizationId || !input.name?.trim()) {
    return failure(context, 'リスト名を入力してください。');
  }
  if (!['source', 'recipient', 'line'].includes(input.kind)) {
    return failure(context, 'リスト種別が正しくありません。');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.ORG_DB.prepare(
    `INSERT INTO lists
      (id, organization_id, kind, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.organizationId,
      input.kind,
      input.name.trim(),
      input.description?.trim() ?? '',
      now,
      now,
    )
    .run();

  const list: TypedList = {
    id,
    organizationId: input.organizationId,
    kind: input.kind,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    itemCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  return json(context, list, 201);
});

app.delete('/api/lists/:id', async (context) => {
  await context.env.ORG_DB.prepare('DELETE FROM lists WHERE id = ?')
    .bind(context.req.param('id'))
    .run();
  return json(context, { deleted: true });
});

app.get('/api/lists/:id/items', async (context) => {
  const result = await context.env.ORG_DB.prepare(
    'SELECT id, list_id, value, label, enabled FROM list_items WHERE list_id = ? ORDER BY label, value',
  )
    .bind(context.req.param('id'))
    .all<ListItemRow>();
  const items: ListItem[] = result.results.map((row) => ({
    id: row.id,
    listId: row.list_id,
    value: row.value,
    label: row.label,
    enabled: row.enabled === 1,
  }));
  return json(context, items);
});

app.post('/api/lists/:id/items', async (context) => {
  const input = await context.req.json<ItemInput>();
  if (!input.value?.trim()) {
    return failure(context, '値を入力してください。');
  }
  const id = crypto.randomUUID();
  await context.env.ORG_DB.prepare(
    'INSERT INTO list_items (id, list_id, value, label, enabled) VALUES (?, ?, ?, ?, 1)',
  )
    .bind(id, context.req.param('id'), input.value.trim(), input.label?.trim() ?? '')
    .run();
  const item: ListItem = {
    id,
    listId: context.req.param('id'),
    value: input.value.trim(),
    label: input.label?.trim() ?? '',
    enabled: true,
  };
  return json(context, item, 201);
});

app.delete('/api/items/:id', async (context) => {
  await context.env.ORG_DB.prepare('DELETE FROM list_items WHERE id = ?')
    .bind(context.req.param('id'))
    .run();
  return json(context, { deleted: true });
});

app.get('/api/rules/:organizationId', async (context) => {
  const result = await context.env.ORG_DB.prepare(
    'SELECT * FROM rules WHERE organization_id = ? ORDER BY updated_at DESC',
  )
    .bind(context.req.param('organizationId'))
    .all<RuleRow>();
  return json(context, result.results.map(toRule));
});

app.post('/api/rules', async (context) => {
  const input = await context.req.json<RuleInput>();
  if (!input.organizationId || !input.name?.trim()) {
    return failure(context, 'ルール名を入力してください。');
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await context.env.ORG_DB.prepare(
    `INSERT INTO rules
      (id, organization_id, name, status, source_list_id, recipient_list_id, line_list_id,
       schedule_minutes, require_attendance, deadline_days_before, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.organizationId,
      input.name.trim(),
      input.status ?? 'draft',
      input.sourceListId ?? null,
      input.recipientListId ?? null,
      input.lineListId ?? null,
      input.scheduleMinutes ?? 5,
      input.requireAttendance ? 1 : 0,
      input.deadlineDaysBefore ?? null,
      now,
      now,
    )
    .run();
  const row = await context.env.ORG_DB.prepare('SELECT * FROM rules WHERE id = ?')
    .bind(id)
    .first<RuleRow>();
  if (!row) return failure(context, '作成したルールを取得できませんでした。', 500);
  return json(context, toRule(row), 201);
});

app.patch('/api/rules/:id/status', async (context) => {
  const input = await context.req.json<{ status?: AutomationRule['status'] }>();
  if (!input.status || !['draft', 'active', 'suspended', 'archived'].includes(input.status)) {
    return failure(context, 'ルール状態が正しくありません。');
  }
  await context.env.ORG_DB.prepare('UPDATE rules SET status = ?, updated_at = ? WHERE id = ?')
    .bind(input.status, new Date().toISOString(), context.req.param('id'))
    .run();
  return json(context, { updated: true });
});

app.get('/api/events/:organizationId', async (context) => {
  return json(context, await eventQuery(context.env.ORG_DB, context.req.param('organizationId'), 100));
});

app.post('/api/automation/:organizationId/run', async (context) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await context.env.ORG_DB.prepare(
    `INSERT INTO jobs (id, kind, payload, state, available_at, created_at, updated_at)
     VALUES (?, 'gmail_sync', ?, 'pending', ?, ?, ?)`,
  )
    .bind(id, JSON.stringify({ organizationId: context.req.param('organizationId') }), now, now, now)
    .run();
  return json(context, { jobId: id, state: 'pending' }, 201);
});

app.get('/api/exceptions', async (context) => {
  const result = await context.env.ORG_DB.prepare(
    'SELECT * FROM exceptions WHERE state = ? ORDER BY created_at DESC LIMIT 100',
  )
    .bind('open')
    .all();
  return json(context, result.results);
});

app.get('/attendance/:token', async (context) => {
  const row = await context.env.ORG_DB.prepare(
    `SELECT a.status, a.comment, e.title, e.starts_at, e.attendance_deadline
     FROM attendance a JOIN events e ON e.id = a.event_id WHERE a.token = ?`,
  )
    .bind(context.req.param('token'))
    .first();
  if (!row) return failure(context, '参加登録リンクが見つかりません。', 404);
  return json(context, row);
});

app.post('/attendance/:token', async (context) => {
  const input = await context.req.json<{
    status?: 'attending' | 'not_attending';
    comment?: string;
  }>();
  if (!input.status || !['attending', 'not_attending'].includes(input.status)) {
    return failure(context, '参加または不参加を選択してください。');
  }
  const result = await context.env.ORG_DB.prepare(
    `UPDATE attendance SET status = ?, comment = ?, updated_at = ?
     WHERE token = ? AND EXISTS (
       SELECT 1 FROM events e WHERE e.id = attendance.event_id
       AND (e.attendance_deadline IS NULL OR e.attendance_deadline >= ?)
     )`,
  )
    .bind(
      input.status,
      input.comment?.trim() ?? '',
      new Date().toISOString(),
      context.req.param('token'),
      new Date().toISOString(),
    )
    .run();
  if (result.meta.changes === 0) {
    return failure(context, '期限を過ぎているため変更できません。', 409);
  }
  return json(context, { updated: true });
});

const eventQuery = async (
  database: D1Database,
  organizationId: string,
  limit: number,
): Promise<ScheduledEvent[]> => {
  const result = await database
    .prepare(
      `SELECT e.id, e.organization_id, e.title, e.starts_at, e.ends_at, e.location,
        e.status, e.attendance_deadline, e.updated_at, s.subject AS source_subject,
        SUM(CASE WHEN a.status = 'attending' THEN 1 ELSE 0 END) AS attending,
        SUM(CASE WHEN a.status = 'not_attending' THEN 1 ELSE 0 END) AS not_attending,
        SUM(CASE WHEN a.status = 'unanswered' THEN 1 ELSE 0 END) AS unanswered
       FROM events e
       LEFT JOIN source_messages s ON s.id = e.source_message_id
       LEFT JOIN attendance a ON a.event_id = e.id
       WHERE e.organization_id = ?
       GROUP BY e.id ORDER BY e.starts_at DESC LIMIT ?`,
    )
    .bind(organizationId, limit)
    .all<EventRow>();
  return result.results.map(toEvent);
};

export { app };

import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Automation, AutomationRun } from '@mail/domain';

import { CHAT_INTERNAL_TOOLS, INTERNAL_WRITE_TOOLS } from '../chat';
import { now } from '../clock';
import { invalid } from '../refusal';
import { resource } from '../response';
import { nextScheduledRun, parseSchedule } from '../schedule';
import { automationRuns, automations, automationTools } from '../storage/account-schema';
import { SUPPRESSION_WINDOWS, type SuppressionWindow } from '../suppression';
import { accountRoute } from './account';

export const automationRoutes = resource();

const AUTOMATION_STATES = ['draft', 'active', 'suspended', 'archived'] as const;
type AutomationState = (typeof AUTOMATION_STATES)[number];
type ExecutionMode = 'read_only' | 'approval' | 'unattended';
const EXECUTION_MODES: readonly ExecutionMode[] = ['read_only', 'approval', 'unattended'];
const INTERNAL_TOOL_NAMES = [...CHAT_INTERNAL_TOOLS, ...INTERNAL_WRITE_TOOLS].map((tool) => tool.name);

const automationView = (row: typeof automations.$inferSelect, tools: string[]) => ({
  id: row.id,
  name: row.name,
  promptId: row.promptId,
  contactListId: row.contactListId,
  schedule: row.schedule,
  offsetMinutes: row.offsetMinutes,
  executionMode: row.executionMode,
  suppressionWindow: row.suppressionWindow,
  state: row.state,
  nextRunAt: row.nextRunAt,
  lastRunAt: row.lastRunAt,
  lastError: row.lastError,
  tools,
});

automationRoutes.get('/organizations/:accountId/automations', accountRoute(async ({ db }): Promise<Automation[]> => {
  const rows = await db.select().from(automations).orderBy(asc(automations.name)).all();
  const grants = rows.length
    ? await db.select().from(automationTools).where(inArray(automationTools.automationId, rows.map(({ id }) => id))).all()
    : [];
  return rows.map((row) => automationView(row, grants.flatMap((grant) => grant.automationId === row.id ? [grant.tool] : [])));
}));

automationRoutes.get('/organizations/:accountId/automations/:automationId/runs', accountRoute(async ({ db, params }): Promise<AutomationRun[]> =>
  db.select().from(automationRuns).where(eq(automationRuns.automationId, params.automationId ?? ''))
    .orderBy(desc(automationRuns.startedAt)).limit(20).all()));

interface AutomationInput {
  name?: string;
  promptId?: string;
  contactListId?: string | null;
  schedule?: string;
  offsetMinutes?: number;
  executionMode?: string;
  suppressionWindow?: string;
  state?: string;
  tools?: unknown;
}

automationRoutes.put('/organizations/:accountId/automations/:automationId', accountRoute<AutomationInput>(async ({ db, accountId, body, params }) => {
  const automationId = params.automationId ?? '';
  const name = body.name?.trim() ?? '';
  const promptId = body.promptId?.trim() ?? '';
  const schedule = body.schedule?.trim() ?? '';
  if (!name || name.length > 60) throw invalid('Automation 名は 1〜60 文字で入力してください。');
  if (!promptId) throw invalid('Prompt を選んでください。');
  if (!parseSchedule(schedule)) throw invalid('スケジュールは daily HH:MM / weekly mon HH:MM / hourly :MM の形式で入力してください。');
  const offsetMinutes = Math.trunc(body.offsetMinutes ?? 0);
  if (offsetMinutes < -840 || offsetMinutes > 840) throw invalid('タイムゾーンのオフセットが範囲外です。');
  const executionMode = (body.executionMode ?? 'unattended') as ExecutionMode;
  if (!EXECUTION_MODES.includes(executionMode)) throw invalid('実行モードの指定が不正です。');
  const suppressionWindow = (body.suppressionWindow ?? 'day') as SuppressionWindow;
  if (!SUPPRESSION_WINDOWS.includes(suppressionWindow)) throw invalid('重複抑止の窓の指定が不正です。');
  const state = (body.state ?? 'draft') as AutomationState;
  if (!AUTOMATION_STATES.includes(state)) throw invalid('状態の指定が不正です。');
  const requested = Array.isArray(body.tools) ? body.tools.filter((tool): tool is string => typeof tool === 'string') : [];
  const contactListId = body.contactListId?.trim() || null;
  const writesGranted = requested.some((tool) => INTERNAL_WRITE_TOOLS.some((write) => write.name === tool));
  if (writesGranted && !contactListId) throw invalid('送信を許可する Automation には、届けてよい Contact List が必要です。');

  const timestamp = now();
  const nextRunAt = state === 'active' ? nextScheduledRun({ schedule, offsetMinutes, after: new Date(timestamp) }) : null;
  await db.insert(automations).values({
    id: automationId, accountId, name, promptId, contactListId, schedule, offsetMinutes,
    executionMode, suppressionWindow, state, nextRunAt, createdAt: timestamp, updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: automations.id,
    set: { name, promptId, contactListId, schedule, offsetMinutes, executionMode, suppressionWindow, state, nextRunAt, updatedAt: timestamp },
  }).run();
  await db.delete(automationTools).where(eq(automationTools.automationId, automationId)).run();
  for (const tool of requested) {
    await db.insert(automationTools).values({ automationId, tool }).onConflictDoNothing().run();
  }
  return { id: automationId, name, schedule, state, nextRunAt, tools: requested, availableInternalTools: INTERNAL_TOOL_NAMES };
}));

automationRoutes.delete('/organizations/:accountId/automations/:automationId', accountRoute(async ({ db, params }) => {
  const automationId = params.automationId ?? '';
  await db.delete(automations).where(eq(automations.id, automationId)).run();
  return { id: automationId, deleted: true };
}));

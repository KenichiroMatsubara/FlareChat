import { decrypt, encrypt, masterKey, unwrapOrganizationKey } from './cryptography';
import { fromBase64Url } from './encoding';
import { extractGeminiEventDetails } from './event-details';
import { refreshGoogleToken } from './google';
import type { GoogleTokenSet } from './google';
import type { Bindings, ConnectionRow, GoogleAutomationRow } from './types';

interface GmailHistory {
  historyId?: string;
  nextPageToken?: string;
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
}

interface GmailMessage {
  id?: string;
  payload?: GmailPart;
  snippet?: string;
}

interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface CalendarEvent {
  id?: string;
}

interface ActiveOrganization {
  id: string;
  binding_name: string;
  database_id: string;
}

interface AutomationInbox {
  id: string;
  kind: 'automation_inbox';
  google_subject: string;
  inbox_address: string;
  granted_scopes: string;
  token_envelope: string;
  gmail_history_id: string;
  status: 'active' | 'reauthentication_required' | 'disconnected';
}

export interface AutomationSummary {
  scanned: number;
  created: number;
  skipped: number;
  exceptions: number;
}

interface EventCandidate {
  title: string;
  startsAt: string;
  endsAt: string;
}

export interface ActiveRule {
  id: string;
  priority: number;
  selectionPolicy: Record<string, unknown>;
}

export interface RuleSource {
  sender: string;
  subject: string;
  body: string;
}

const now = (): string => new Date().toISOString();

const googleFetch = async <T>(accessToken: string, url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? 'Google API request failed.');
  return body;
};

const decodedBody = (part: GmailPart | undefined): string => {
  if (!part) return '';
  const own = part.body?.data ? new TextDecoder().decode(fromBase64Url(part.body.data)) : '';
  const nested = part.parts?.map(decodedBody).join('\n') ?? '';
  return `${own}\n${nested}`.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
};

const subjectOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'subject')?.value?.trim() ?? '(件名なし)';

const senderOf = (part: GmailPart | undefined): string =>
  part?.headers?.find((header) => header.name?.toLowerCase() === 'from')?.value?.trim() ?? '';

const padded = (value: number): string => String(value).padStart(2, '0');

const japanDateTime = (year: number, month: number, day: number, hour: number, minute: number): string =>
  `${year}-${padded(month)}-${padded(day)}T${padded(hour)}:${padded(minute)}:00+09:00`;

/** Extracts an event only when the message states both a date and a time range. */
export const extractEventCandidate = (subject: string, body: string, current = new Date()): EventCandidate | null => {
  const text = `${subject}\n${body}`;
  const date = text.match(/(?:(\d{4})\s*(?:年|[/-]))?\s*(\d{1,2})\s*(?:月|[/-])\s*(\d{1,2})\s*日?/u);
  const time = text.match(/(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(?:時)?\s*(?:-|〜|～|to)\s*(\d{1,2})(?::(\d{2}))?\s*(?:時)?/iu);
  if (!date || !time) return null;
  const year = date[1] ? Number(date[1]) : current.getFullYear();
  const month = Number(date[2]);
  const day = Number(date[3]);
  const startHour = Number(time[1]);
  const startMinute = Number(time[2] ?? '0');
  const endHour = Number(time[3]);
  const endMinute = Number(time[4] ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31 || startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
  return {
    title: subject.replace(/^(?:re|fw|fwd)\s*:\s*/iu, '').trim() || 'メールから作成した予定',
    startsAt: japanDateTime(year, month, day, startHour, startMinute),
    endsAt: japanDateTime(year, month, day, endHour, endMinute),
  };
};

/** Chooses exactly one active Rule, using descending priority after policy matching. */
export const selectActiveRule = (rules: ActiveRule[], source: RuleSource): ActiveRule | null => {
  const sender = source.sender.trim().toLowerCase();
  const domain = sender.split('@')[1] ?? '';
  const content = `${source.subject}\n${source.body}`.toLowerCase();
  const matching = rules.filter((rule) => {
    const policy = rule.selectionPolicy;
    const requiredSender = typeof policy.sender === 'string' ? policy.sender.trim().toLowerCase() : '';
    const requiredDomain = typeof policy.domain === 'string' ? policy.domain.trim().toLowerCase() : '';
    const requiredKeyword = typeof policy.keyword === 'string' ? policy.keyword.trim().toLowerCase() : '';
    return (!requiredSender || requiredSender === sender)
      && (!requiredDomain || requiredDomain === domain)
      && (!requiredKeyword || content.includes(requiredKeyword));
  });
  return matching.sort((left, right) => right.priority - left.priority)[0] ?? null;
};

const accessTokenFor = async (env: Bindings, automation: GoogleAutomationRow): Promise<string> => {
  const key = await masterKey(env.CREDENTIAL_MASTER_KEY);
  const token = JSON.parse(await decrypt(JSON.parse(automation.token_envelope), key, `google-automation:${automation.id}`)) as GoogleTokenSet;
  if (Date.parse(token.expiresAt) > Date.now() + 60_000) return token.accessToken;
  const refreshed = await refreshGoogleToken({
    refreshToken: token.refreshToken,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  });
  const envelope = await encrypt(JSON.stringify(refreshed), key, `google-automation:${automation.id}`);
  await env.CONTROL_DB.prepare('UPDATE google_automations SET token_envelope = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(envelope), now(), automation.id).run();
  return refreshed.accessToken;
};

const organizationKeyFor = async (env: Bindings, organizationId: string): Promise<CryptoKey> => {
  const record = await env.CONTROL_DB.prepare(
    'SELECT master_key_version, wrapped_key_envelope FROM organization_keys WHERE organization_id = ?',
  ).bind(organizationId).first<{ master_key_version: string; wrapped_key_envelope: string }>();
  if (!record) throw new Error('Organization encryption key is missing.');
  return unwrapOrganizationKey({ masterKeyVersion: record.master_key_version, envelope: JSON.parse(record.wrapped_key_envelope) }, await masterKey(env.CREDENTIAL_MASTER_KEY), organizationId);
};

const accessTokenForInbox = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
): Promise<string> => {
  const key = await organizationKeyFor(env, organizationId);
  const token = JSON.parse(await decrypt(JSON.parse(inbox.token_envelope), key, `google-connection:${organizationId}:automation-inbox`)) as GoogleTokenSet;
  if (Date.parse(token.expiresAt) > Date.now() + 60_000) return token.accessToken;
  const refreshed = await refreshGoogleToken({
    refreshToken: token.refreshToken,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  });
  const envelope = await encrypt(JSON.stringify(refreshed), key, `google-connection:${organizationId}:automation-inbox`);
  await database.prepare('UPDATE google_connections SET token_envelope = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(envelope), now(), inbox.id).run();
  return refreshed.accessToken;
};

/** Uses the Organization-scoped Gemini connection when it is configured. */
const geminiCandidate = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  source: string,
): Promise<EventCandidate | null | undefined> => {
  const connection = await database.prepare("SELECT * FROM connections WHERE kind = 'ai' AND status = 'active' LIMIT 1")
    .bind().first<ConnectionRow>();
  if (!connection) return undefined;
  try {
    const key = await organizationKeyFor(env, organizationId);
    const credential = JSON.parse(await decrypt(JSON.parse(connection.credential), key, `organization-connection:${organizationId}:ai`)) as { provider?: string; apiKey?: string; model?: string };
    if (credential.provider !== 'Google Gemini API' || !credential.apiKey || !credential.model) return null;
    const details = await extractGeminiEventDetails({ apiKey: credential.apiKey, model: credential.model, source });
    return details && { title: details.title, startsAt: details.startsAt, endsAt: details.endsAt };
  } catch {
    return null;
  }
};

const processOrganizationMessage = async (
  env: Bindings,
  database: D1Database,
  organizationId: string,
  accessToken: string,
  gmailHistoryId: string,
  gmailMessageId: string,
): Promise<void> => {
  const known = await database.prepare('SELECT id FROM source_messages WHERE gmail_message_id = ?')
    .bind(gmailMessageId).first<{ id: string }>();
  if (known) return;
  const message = await googleFetch<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=full`);
  const subject = subjectOf(message.payload);
  const sourceMessageId = crypto.randomUUID();
  const timestamp = now();
  await database.prepare(
    "INSERT INTO source_messages (id, gmail_message_id, gmail_history_id, sender, subject, received_at, processed_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')",
  ).bind(sourceMessageId, gmailMessageId, gmailHistoryId, senderOf(message.payload), subject, timestamp, timestamp).run();
  const body = decodedBody(message.payload) || (message.snippet ?? '');
  const rules = await database.prepare("SELECT id, priority, selection_policy FROM rules WHERE status = 'active' ORDER BY priority DESC")
    .all<{ id: string; priority: number; selection_policy: string }>();
  const rule = selectActiveRule(rules.results.flatMap((row) => {
    try { return [{ id: row.id, priority: row.priority, selectionPolicy: JSON.parse(row.selection_policy) as Record<string, unknown> }]; }
    catch { return []; }
  }), { sender: senderOf(message.payload), subject, body });
  if (!rule) {
    await database.prepare("UPDATE source_messages SET state = 'skipped', processed_at = ? WHERE id = ?")
      .bind(now(), sourceMessageId).run();
    return;
  }
  const aiCandidate = await geminiCandidate(env, organizationId, database, `${subject}\n${body}`);
  if (aiCandidate === null) {
    await database.prepare("INSERT INTO exceptions (id, source_message_id, code, message, state, created_at) VALUES (?, ?, 'gemini_event_details_invalid', ?, 'open', ?)")
      .bind(crypto.randomUUID(), sourceMessageId, 'Gemini could not produce safe Event Details.', now()).run();
    await database.prepare("UPDATE source_messages SET state = 'exception', processed_at = ? WHERE id = ?")
      .bind(now(), sourceMessageId).run();
    return;
  }
  const candidate = aiCandidate ?? extractEventCandidate(subject, body);
  if (!candidate) {
    await database.prepare("UPDATE source_messages SET state = 'skipped', processed_at = ? WHERE id = ?")
      .bind(now(), sourceMessageId).run();
    return;
  }
  const event = await googleFetch<CalendarEvent>(accessToken, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: JSON.stringify({
      summary: candidate.title,
      description: `Mail Automation が Gmail メッセージ ${gmailMessageId} から作成しました。`,
      start: { dateTime: candidate.startsAt, timeZone: 'Asia/Tokyo' },
      end: { dateTime: candidate.endsAt, timeZone: 'Asia/Tokyo' },
    }),
  });
  if (!event.id) throw new Error('Google Calendar did not return an event ID.');
  await database.prepare(
    "INSERT INTO events (id, organization_id, rule_id, source_message_id, google_event_id, title, starts_at, ends_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)",
  ).bind(crypto.randomUUID(), organizationId, rule.id, sourceMessageId, event.id, candidate.title, candidate.startsAt, candidate.endsAt, now(), now()).run();
  await database.prepare("UPDATE source_messages SET state = 'processed', processed_at = ? WHERE id = ?")
    .bind(now(), sourceMessageId).run();
};

const runOrganizationInbox = async (
  env: Bindings,
  organizationId: string,
  database: D1Database,
  inbox: AutomationInbox,
): Promise<void> => {
  const accessToken = await accessTokenForInbox(env, organizationId, database, inbox);
  let pageToken: string | undefined;
  let historyId = inbox.gmail_history_id;
  do {
    const query = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    query.searchParams.set('startHistoryId', inbox.gmail_history_id);
    query.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) query.searchParams.set('pageToken', pageToken);
    const history = await googleFetch<GmailHistory>(accessToken, query.toString());
    for (const entry of history.history ?? []) {
      for (const message of entry.messagesAdded ?? []) {
        if (message.message?.id) await processOrganizationMessage(env, database, organizationId, accessToken, inbox.gmail_history_id, message.message.id);
      }
    }
    historyId = history.historyId ?? historyId;
    pageToken = history.nextPageToken;
  } while (pageToken);
  await database.prepare('UPDATE google_connections SET gmail_history_id = ?, updated_at = ? WHERE id = ?')
    .bind(historyId, now(), inbox.id).run();
};

const recordMessage = async (
  env: Bindings,
  automationId: string,
  gmailMessageId: string,
  subject: string,
  status: 'created' | 'skipped' | 'exception',
  calendarEventId: string | null,
  error: string | null,
): Promise<boolean> => {
  const result = await env.CONTROL_DB.prepare(
    `INSERT OR IGNORE INTO automation_messages
      (id, automation_id, gmail_message_id, subject, calendar_event_id, status, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), automationId, gmailMessageId, subject, calendarEventId, status, error, now(), now()).run();
  return result.meta.changes > 0;
};

const processMessage = async (
  env: Bindings,
  automation: GoogleAutomationRow,
  accessToken: string,
  gmailMessageId: string,
  summary: AutomationSummary,
): Promise<void> => {
  const known = await env.CONTROL_DB.prepare('SELECT id FROM automation_messages WHERE automation_id = ? AND gmail_message_id = ?')
    .bind(automation.id, gmailMessageId).first<{ id: string }>();
  if (known) return;
  summary.scanned += 1;
  try {
    const message = await googleFetch<GmailMessage>(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(gmailMessageId)}?format=full`);
    const subject = subjectOf(message.payload);
    const candidate = extractEventCandidate(subject, decodedBody(message.payload) || (message.snippet ?? ''));
    if (!candidate) {
      if (await recordMessage(env, automation.id, gmailMessageId, subject, 'skipped', null, '日付と開始・終了時刻を認識できませんでした。')) summary.skipped += 1;
      return;
    }
    const event = await googleFetch<CalendarEvent>(accessToken, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      body: JSON.stringify({
        summary: candidate.title,
        description: `Mail Automation が Gmail メッセージ ${gmailMessageId} から作成しました。`,
        start: { dateTime: candidate.startsAt, timeZone: 'Asia/Tokyo' },
        end: { dateTime: candidate.endsAt, timeZone: 'Asia/Tokyo' },
      }),
    });
    if (!event.id) throw new Error('Google Calendar did not return an event ID.');
    if (await recordMessage(env, automation.id, gmailMessageId, subject, 'created', event.id, null)) summary.created += 1;
  } catch (error) {
    const recorded = await recordMessage(
      env,
      automation.id,
      gmailMessageId,
      '(メッセージを取得できませんでした)',
      'exception',
      null,
      error instanceof Error ? error.message : 'メッセージの自動化に失敗しました。',
    );
    if (recorded) summary.exceptions += 1;
  }
};

export const runAutomation = async (env: Bindings, automation: GoogleAutomationRow): Promise<AutomationSummary> => {
  const summary: AutomationSummary = { scanned: 0, created: 0, skipped: 0, exceptions: 0 };
  const accessToken = await accessTokenFor(env, automation);
  let pageToken: string | undefined;
  let historyId = automation.gmail_history_id;
  do {
    const query = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
    query.searchParams.set('startHistoryId', automation.gmail_history_id);
    query.searchParams.set('historyTypes', 'messageAdded');
    if (pageToken) query.searchParams.set('pageToken', pageToken);
    const history = await googleFetch<GmailHistory>(accessToken, query.toString());
    for (const entry of history.history ?? []) {
      for (const message of entry.messagesAdded ?? []) {
        if (message.message?.id) await processMessage(env, automation, accessToken, message.message.id, summary);
      }
    }
    historyId = history.historyId ?? historyId;
    pageToken = history.nextPageToken;
  } while (pageToken);
  await env.CONTROL_DB.prepare('UPDATE google_automations SET gmail_history_id = ?, last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?')
    .bind(historyId, now(), now(), automation.id).run();
  return summary;
};

export const runAutomationForIdentity = async (env: Bindings, identityId: string): Promise<AutomationSummary> => {
  const automation = await env.CONTROL_DB.prepare('SELECT * FROM google_automations WHERE identity_id = ? AND enabled = 1')
    .bind(identityId).first<GoogleAutomationRow>();
  if (!automation) throw new Error('有効な Google 自動化が見つかりません。');
  return runAutomation(env, automation);
};

export const runEnabledAutomations = async (env: Bindings): Promise<void> => {
  const organizations = await env.CONTROL_DB.prepare(
    "SELECT id, binding_name, database_id FROM organizations WHERE status = 'active' AND database_id IS NOT NULL ORDER BY updated_at LIMIT 20",
  ).all<ActiveOrganization>();
  for (const organization of organizations.results) {
    const database = (env as unknown as Record<string, unknown>)[organization.binding_name];
    if (!database || typeof database !== 'object') continue;
    const inboxes = await (database as D1Database).prepare(
      "SELECT * FROM google_connections WHERE kind = 'automation_inbox' AND status = 'active'",
    ).all<AutomationInbox>();
    for (const inbox of inboxes.results) {
      try {
        await runOrganizationInbox(env, organization.id, database as D1Database, inbox);
      } catch {
        await (database as D1Database).prepare("UPDATE google_connections SET status = 'reauthentication_required', updated_at = ? WHERE id = ?")
          .bind(now(), inbox.id).run();
      }
    }
  }
};

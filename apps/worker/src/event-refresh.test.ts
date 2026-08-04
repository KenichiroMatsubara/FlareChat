import { describe, expect, it } from 'vitest';

import {
  attributedMessageId,
  buildEventCorrespondenceRequest,
  changedCalendarFields,
  partitionByRefreshWindow,
  refreshPlan,
  refreshSearchWindow,
  sourceMessageAttribution,
  validatedEventCorrespondences,
  withinRefreshWindow,
} from './event-refresh';
import type { CalendarEventFields, DesiredCalendarFields } from './event-refresh';
import type { EventDetails } from './event-details';

const candidate = (overrides: Partial<EventDetails> = {}): EventDetails => ({
  title: '例会',
  startsAt: '2026-08-03T19:00:00+09:00',
  endsAt: '2026-08-03T21:30:00+09:00',
  timeZone: 'Asia/Tokyo',
  location: '公民館',
  description: '定例の例会',
  summary: '例会です。会費は不要です。',
  ...overrides,
});

const scheduled = (overrides: Partial<CalendarEventFields> = {}): CalendarEventFields => ({
  id: 'calendar-event-1',
  etag: '"etag-1"',
  title: '例会',
  description: sourceMessageAttribution('gmail-1'),
  location: '公民館',
  startsAt: '2026-08-03T19:00:00+09:00',
  endsAt: '2026-08-03T21:30:00+09:00',
  timeZone: 'Asia/Tokyo',
  ...overrides,
});

const desiredFrom = (details: EventDetails, description: string): DesiredCalendarFields => ({
  title: details.title,
  description,
  location: details.location,
  startsAt: details.startsAt,
  endsAt: details.endsAt,
  timeZone: details.timeZone,
});

describe('the Source Attribution', () => {
  it('reads the Gmail message ID back out of the sentence it writes', () => {
    expect(attributedMessageId(sourceMessageAttribution('gmail-message-1'))).toBe('gmail-message-1');
  });

  it('still reads the manual-test wording written before the sentence was unified', () => {
    expect(attributedMessageId('Mail Automation の手動テストで Gmail メッセージ legacy-1 から作成しました。'))
      .toBe('legacy-1');
  });

  it('reads the sentence when a Public Attachment list precedes it', () => {
    const description = ['要約です。', '添付ファイル:', '<a href="https://drive.example/a">案内.pdf</a>', sourceMessageAttribution('gmail-2')].join('<br><br>');
    expect(attributedMessageId(description)).toBe('gmail-2');
  });

  it('reports no correlation for a description an Admin wrote by hand', () => {
    expect(attributedMessageId('手で作成した予定です。')).toBeNull();
  });
});

describe('the refresh window', () => {
  it('accepts a start time the old extraction placed a day away', () => {
    expect(withinRefreshWindow('2026-08-03T19:00:00+09:00', '2026-08-04T19:00:00+09:00')).toBe(true);
  });

  it('rejects a start time three weeks away, which is another meeting', () => {
    expect(withinRefreshWindow('2026-08-03T19:00:00+09:00', '2026-08-24T19:00:00+09:00')).toBe(false);
  });

  it('searches wider than it corresponds so a stale duplicate stays visible', () => {
    const window = refreshSearchWindow([candidate()]);
    expect(window).not.toBeNull();
    expect(Date.parse(window!.timeMin)).toBeLessThan(Date.parse('2026-07-01T00:00:00+09:00'));
    expect(Date.parse(window!.timeMax)).toBeGreaterThan(Date.parse('2026-09-01T00:00:00+09:00'));
  });

  it('has no window to search when no candidate carries a usable start', () => {
    expect(refreshSearchWindow([candidate({ startsAt: 'not-a-date' })])).toBeNull();
  });

  it('separates the events a candidate may claim from the ones only shown', () => {
    const near = scheduled({ id: 'near' });
    const far = scheduled({ id: 'far', startsAt: '2026-10-03T19:00:00+09:00', endsAt: '2026-10-03T21:30:00+09:00' });
    expect(partitionByRefreshWindow([candidate()], [near, far])).toEqual({ inWindow: [near], outOfWindow: [far] });
  });
});

describe('the field diff', () => {
  it('names every field the refresh would replace', () => {
    const changed = changedCalendarFields(scheduled(), desiredFrom(candidate({
      title: '例会（変更）',
      location: '市民ホール',
    }), 'new description'));
    expect(changed).toEqual(['title', 'description', 'location']);
  });

  it('reports no change when the same instant is written a different way', () => {
    const current = scheduled({ description: 'same', startsAt: '2026-08-03T10:00:00Z', endsAt: '2026-08-03T12:30:00Z' });
    expect(changedCalendarFields(current, desiredFrom(candidate(), 'same'))).toEqual([]);
  });
});

describe('the correspondence request', () => {
  it('offers the AI only the listed events and a new-event choice', () => {
    const request = buildEventCorrespondenceRequest({ candidates: [candidate()], existing: [scheduled()] });
    const schema = request.response_format.json_schema.schema.properties?.['correspondences']?.items?.properties;
    expect(schema?.['eventId']?.enum).toEqual(['calendar-event-1', 'new']);
    expect(schema?.['candidateIndex']?.enum).toEqual(['0']);
  });

  it('sends the Calendar fields and never the message body', () => {
    const request = buildEventCorrespondenceRequest({ candidates: [candidate()], existing: [scheduled()] });
    expect(request.messages[1]?.content).toContain('calendar-event-1');
    expect(request.messages[0]?.content).toContain('untrusted');
  });
});

describe('the validated correspondence', () => {
  const input = { candidates: [candidate(), candidate({ title: '懇親会' })], existing: [scheduled()] };

  it('accepts a decision that names a listed event and a new one', () => {
    const text = JSON.stringify({ correspondences: [
      { candidateIndex: '0', eventId: 'calendar-event-1' },
      { candidateIndex: '1', eventId: 'new' },
    ] });
    expect(validatedEventCorrespondences(text, input)).toEqual([
      { candidateIndex: 0, eventId: 'calendar-event-1' },
      { candidateIndex: 1, eventId: null },
    ]);
  });

  it('rejects an event ID the AI invented', () => {
    const text = JSON.stringify({ correspondences: [{ candidateIndex: '0', eventId: 'calendar-event-9' }] });
    expect(validatedEventCorrespondences(text, input)).toBeNull();
  });

  it('rejects one existing event claimed by two candidates', () => {
    const text = JSON.stringify({ correspondences: [
      { candidateIndex: '0', eventId: 'calendar-event-1' },
      { candidateIndex: '1', eventId: 'calendar-event-1' },
    ] });
    expect(validatedEventCorrespondences(text, input)).toBeNull();
  });

  it('rejects a candidate index outside the extraction', () => {
    const text = JSON.stringify({ correspondences: [{ candidateIndex: '5', eventId: 'new' }] });
    expect(validatedEventCorrespondences(text, input)).toBeNull();
  });
});

describe('the approved plan', () => {
  it('turns a correspondence into an update and leaves the rest untouched', () => {
    const target = scheduled({ description: 'stale' });
    const other = scheduled({ id: 'calendar-event-2', startsAt: '2026-08-04T19:00:00+09:00', endsAt: '2026-08-04T20:00:00+09:00' });
    const details = candidate();
    const plan = refreshPlan({
      candidates: [details],
      existing: [target, other],
      correspondences: [{ candidateIndex: 0, eventId: 'calendar-event-1' }],
      desired: [desiredFrom(details, 'fresh')],
    });
    expect(plan.entries[0]?.target?.id).toBe('calendar-event-1');
    expect(plan.entries[0]?.changedFields).toEqual(['description']);
    expect(plan.unmatched.map((event) => event.id)).toEqual(['calendar-event-2']);
    expect(plan.outOfWindow).toEqual([]);
  });

  it('refuses a distant match so attendees never move to another meeting', () => {
    const distant = scheduled({ startsAt: '2026-09-20T19:00:00+09:00', endsAt: '2026-09-20T21:00:00+09:00' });
    const details = candidate();
    const plan = refreshPlan({
      candidates: [details],
      existing: [distant],
      correspondences: [{ candidateIndex: 0, eventId: 'calendar-event-1' }],
      desired: [desiredFrom(details, 'fresh')],
    });
    expect(plan.entries[0]?.target).toBeNull();
    expect(plan.outOfWindow.map((event) => event.id)).toEqual(['calendar-event-1']);
  });

  it('creates a candidate the AI matched to nothing', () => {
    const details = candidate();
    const plan = refreshPlan({
      candidates: [details],
      existing: [scheduled()],
      correspondences: [{ candidateIndex: 0, eventId: null }],
      desired: [desiredFrom(details, 'fresh')],
    });
    expect(plan.entries[0]?.target).toBeNull();
    expect(plan.unmatched.map((event) => event.id)).toEqual(['calendar-event-1']);
  });

  it('reports no changed field when the Scheduled Event is already current', () => {
    const details = candidate();
    const description = sourceMessageAttribution('gmail-1');
    const plan = refreshPlan({
      candidates: [details],
      existing: [scheduled({ description })],
      correspondences: [{ candidateIndex: 0, eventId: 'calendar-event-1' }],
      desired: [desiredFrom(details, description)],
    });
    expect(plan.entries[0]?.changedFields).toEqual([]);
  });
});

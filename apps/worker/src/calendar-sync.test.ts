import { describe, expect, it } from 'vitest';
import { recordCalendarDeletion } from './calendar-sync';
describe('Calendar deletion', () => { it('raises an Operations Exception instead of recreating a deleted event', async () => {
  const sql: string[]=[]; const db={prepare:(q:string)=>({bind:(..._v:unknown[])=>({run:async()=>{sql.push(q);return{};}})}),batch:async(s:Array<{run:()=>Promise<unknown>}>)=>{await Promise.all(s.map(x=>x.run()));return[];}} as unknown as D1Database;
  await recordCalendarDeletion(db,{eventId:'event-1',sourceMessageId:'source-1',now:'2026-01-01T00:00:00.000Z'});
  expect(sql.join('\n')).toContain('calendar_event_deleted');
}); });

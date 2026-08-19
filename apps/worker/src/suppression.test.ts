import { describe, expect, it } from 'vitest';

import { canonicalArguments, suppressionKey, suppressionExpiry, SUPPRESSION_WINDOWS } from './suppression';

describe('repeat suppression key', () => {
  it('ignores the order the model happened to write the arguments in', () => {
    const first = suppressionKey({ scope: 'automation-1', tool: 'channel.send', arguments: { to: 'contact-1', text: 'hi' } });
    const second = suppressionKey({ scope: 'automation-1', tool: 'channel.send', arguments: { text: 'hi', to: 'contact-1' } });

    expect(first).toBe(second);
  });

  it('separates two Automations that would otherwise send the same thing', () => {
    const first = suppressionKey({ scope: 'automation-1', tool: 'channel.send', arguments: { to: 'contact-1' } });
    const second = suppressionKey({ scope: 'automation-2', tool: 'channel.send', arguments: { to: 'contact-1' } });

    expect(first).not.toBe(second);
  });

  it('separates a different message to the same Contact', () => {
    const first = suppressionKey({ scope: 'automation-1', tool: 'channel.send', arguments: { to: 'contact-1', text: 'a' } });
    const second = suppressionKey({ scope: 'automation-1', tool: 'channel.send', arguments: { to: 'contact-1', text: 'b' } });

    expect(first).not.toBe(second);
  });

  it('separates the same arguments given to a different tool', () => {
    expect(suppressionKey({ scope: 's', tool: 'channel.send', arguments: { a: 1 } }))
      .not.toBe(suppressionKey({ scope: 's', tool: 'reminder.schedule', arguments: { a: 1 } }));
  });

  it('canonicalises nested objects and leaves array order meaningful', () => {
    expect(canonicalArguments({ b: { d: 2, c: 1 }, a: [2, 1] })).toBe('{"a":[2,1],"b":{"c":1,"d":2}}');
  });

  it('distinguishes a missing value from an explicit null', () => {
    expect(canonicalArguments({ a: 1 })).not.toBe(canonicalArguments({ a: 1, b: null }));
  });
});

describe('suppression window', () => {
  const at = new Date('2026-08-18T09:00:00.000Z');

  it('holds a repeat for the declared window', () => {
    expect(suppressionExpiry({ window: 'day', at })).toBe('2026-08-19T09:00:00.000Z');
    expect(suppressionExpiry({ window: 'week', at })).toBe('2026-08-25T09:00:00.000Z');
    expect(suppressionExpiry({ window: 'hour', at })).toBe('2026-08-18T10:00:00.000Z');
  });

  it('never expires when the window is forever, so the effect happens once only', () => {
    expect(suppressionExpiry({ window: 'forever', at })).toBeNull();
  });

  it('permits a repeat immediately when suppression is switched off', () => {
    expect(suppressionExpiry({ window: 'none', at })).toBe('2026-08-18T09:00:00.000Z');
  });

  it('offers windows an Account can actually choose between', () => {
    expect(SUPPRESSION_WINDOWS).toEqual(['none', 'hour', 'day', 'week', 'forever']);
  });
});

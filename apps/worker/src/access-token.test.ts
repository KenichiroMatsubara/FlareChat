import { describe, expect, it } from 'vitest';

import { accessTokenHash, generateAccessToken, presentedToken, withinCallLimits } from './access-token';

describe('Access Token credential', () => {
  it('hashes what it stores so a leaked database cannot be presented as the token', async () => {
    const token = generateAccessToken();
    const hash = await accessTokenHash(token);

    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
    await expect(accessTokenHash(token)).resolves.toBe(hash);
  });

  it('issues a token long enough not to be guessed', () => {
    const token = generateAccessToken();

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(generateAccessToken()).not.toBe(token);
  });

  it('reads the credential only from the Authorization header, never the query string', () => {
    expect(presentedToken(new Request('https://flarechat.example/mcp', { headers: { Authorization: 'Bearer abc' } }))).toBe('abc');
    expect(presentedToken(new Request('https://flarechat.example/mcp?access_token=abc'))).toBeNull();
    expect(presentedToken(new Request('https://flarechat.example/mcp', { headers: { Authorization: 'abc' } }))).toBeNull();
  });
});

describe('Access Token limits', () => {
  const at = new Date('2026-08-18T09:00:00.000Z');
  const minutesAgo = (minutes: number): string => new Date(at.getTime() - minutes * 60_000).toISOString();

  it('admits a call inside both limits', () => {
    expect(withinCallLimits({
      limits: { callsPerHour: 2, writesPerDay: 2 },
      recent: [{ createdAt: minutesAgo(30), isWrite: false }],
      isWrite: true,
      at,
    })).toEqual({ admitted: true });
  });

  it('refuses once the hourly call limit is reached', () => {
    const outcome = withinCallLimits({
      limits: { callsPerHour: 1, writesPerDay: 10 },
      recent: [{ createdAt: minutesAgo(30), isWrite: false }],
      isWrite: false,
      at,
    });

    expect(outcome.admitted).toBe(false);
    expect(outcome.reason).toContain('hour');
  });

  it('refuses once the daily write limit is reached, counting only writes', () => {
    const outcome = withinCallLimits({
      limits: { callsPerHour: 100, writesPerDay: 1 },
      recent: [{ createdAt: minutesAgo(600), isWrite: true }, { createdAt: minutesAgo(10), isWrite: false }],
      isWrite: true,
      at,
    });

    expect(outcome.admitted).toBe(false);
    expect(outcome.reason).toContain('day');
  });

  it('lets a read through when only the write limit is spent', () => {
    expect(withinCallLimits({
      limits: { callsPerHour: 100, writesPerDay: 1 },
      recent: [{ createdAt: minutesAgo(10), isWrite: true }],
      isWrite: false,
      at,
    })).toEqual({ admitted: true });
  });

  it('forgets calls that fell out of both windows', () => {
    expect(withinCallLimits({
      limits: { callsPerHour: 1, writesPerDay: 1 },
      recent: [{ createdAt: minutesAgo(1441), isWrite: true }],
      isWrite: true,
      at,
    })).toEqual({ admitted: true });
  });

  it('counts each limit in its own window, so an hour-old write still spends the day', () => {
    const recent = [{ createdAt: minutesAgo(61), isWrite: true }];

    expect(withinCallLimits({ limits: { callsPerHour: 1, writesPerDay: 5 }, recent, isWrite: false, at }))
      .toEqual({ admitted: true });
    expect(withinCallLimits({ limits: { callsPerHour: 1, writesPerDay: 1 }, recent, isWrite: true, at }).admitted)
      .toBe(false);
  });
});

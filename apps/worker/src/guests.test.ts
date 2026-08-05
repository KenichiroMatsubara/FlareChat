import { describe, expect, it } from 'vitest';

import { affiliationCounts, guestCountsLine } from './guests';

describe('Guest Registrations', () => {
  it('counts attending guests by Affiliation and leaves the absent out', () => {
    expect(affiliationCounts([
      { name: '山田', affiliation: '北クラブ', attending: true },
      { name: '鈴木', affiliation: '北クラブ', attending: true },
      { name: '佐藤', affiliation: '南クラブ', attending: true },
      { name: '高橋', affiliation: '南クラブ', attending: false },
    ])).toEqual([
      { affiliation: '北クラブ', attending: 2 },
      { affiliation: '南クラブ', attending: 1 },
    ]);
  });

  it('groups the guests whose registration named no body', () => {
    expect(affiliationCounts([{ name: '田中', affiliation: '  ', attending: true }]))
      .toEqual([{ affiliation: '所属未記載', attending: 1 }]);
  });

  it('writes the counts and never the names', () => {
    const line = guestCountsLine([
      { name: '山田', affiliation: '北クラブ', attending: true },
      { name: '佐藤', affiliation: '南クラブ', attending: true },
    ]);

    expect(line).toBe('外部からの参加登録: 2団体 2名（北クラブ 1名、南クラブ 1名）');
    expect(line).not.toContain('山田');
  });

  it('has no line to write when nobody from outside is attending', () => {
    expect(guestCountsLine([])).toBeNull();
    expect(guestCountsLine([{ name: '山田', affiliation: '北クラブ', attending: false }])).toBeNull();
  });
});

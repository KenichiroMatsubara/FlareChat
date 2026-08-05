/** One Guest Registration as the aggregation reads it. */
export interface GuestRegistrationRow {
  name: string;
  affiliation: string;
  attending: boolean;
}

/** The attending headcount for one Affiliation. */
export interface AffiliationCount {
  affiliation: string;
  attending: number;
}

const UNSTATED_AFFILIATION = '所属未記載';

/**
 * Counts attending guests by Affiliation. Only the counts reach a Scheduled
 * Event's Calendar description; the names stay in the management GUI and in the
 * published registration, because a description is rendered on every invited
 * Member's own calendar and a roster is not for all of them to hold.
 */
export const affiliationCounts = (rows: readonly GuestRegistrationRow[]): AffiliationCount[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.attending) continue;
    const affiliation = row.affiliation.trim() || UNSTATED_AFFILIATION;
    counts.set(affiliation, (counts.get(affiliation) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([affiliation, attending]) => ({ affiliation, attending }))
    .sort((left, right) => right.attending - left.attending || left.affiliation.localeCompare(right.affiliation, 'ja'));
};

/**
 * The Guest Registration line for a Calendar description, or null when nobody
 * from outside has registered. Returned as plain text: the caller renders it
 * through the description builder so an Affiliation another organization wrote
 * is escaped there rather than by whoever assembled this string.
 */
export const guestCountsLine = (rows: readonly GuestRegistrationRow[]): string | null => {
  const counts = affiliationCounts(rows);
  if (!counts.length) return null;
  const total = counts.reduce((sum, count) => sum + count.attending, 0);
  const breakdown = counts.map((count) => `${count.affiliation} ${count.attending}名`).join('、');
  return `外部からの参加登録: ${counts.length}団体 ${total}名（${breakdown}）`;
};

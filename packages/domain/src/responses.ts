/**
 * How far from a Scheduled Event's start an Event Response may still be
 * recognised as answering it. It is far wider than the window a merge may write
 * in, because locating a response performs no write on the event: the worst a
 * wrong match produces is a Guest Registration on the wrong meeting, while a
 * wrong merge would carry an existing invitation list onto another one.
 */
export const DEFAULT_RESPONSE_WINDOW_DAYS = 60;

export const MIN_RESPONSE_WINDOW_DAYS = 1;
export const MAX_RESPONSE_WINDOW_DAYS = 365;

export type ResponseWindowRejection = 'not_a_number' | 'out_of_range';

export type ResponseWindowResult =
  | { accepted: true; days: number }
  | { accepted: false; reason: ResponseWindowRejection };

/**
 * Accepts a whole number of days inside the supported range. Zero is refused
 * rather than treated as "off": a window of no days would silently drop every
 * Event Response, and turning the feature off is not what a reader of "0" in
 * a days field would expect.
 */
export const readResponseWindowDays = (value: unknown): ResponseWindowResult => {
  const days = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof days !== 'number' || !Number.isInteger(days)) return { accepted: false, reason: 'not_a_number' };
  if (days < MIN_RESPONSE_WINDOW_DAYS || days > MAX_RESPONSE_WINDOW_DAYS) {
    return { accepted: false, reason: 'out_of_range' };
  }
  return { accepted: true, days };
};

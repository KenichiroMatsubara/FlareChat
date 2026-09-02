/**
 * A refusal is a value with a status and a code (ADR 0169).
 *
 * The request seam and the domain modules throw one of these where a request
 * cannot be honoured, and the HTTP surface is the one place that turns it into
 * a response. Messages stay human, in whichever language the screen needs;
 * nothing reads them to decide anything.
 */
export type RefusalCode =
  | 'unauthenticated'
  | 'no_access'
  | 'account_unavailable'
  | 'database_unavailable'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'invalid'
  | 'upstream';

export type RefusalStatus = 400 | 401 | 403 | 404 | 409 | 410 | 503;

const STATUS: Record<RefusalCode, RefusalStatus> = {
  unauthenticated: 401,
  no_access: 403,
  account_unavailable: 403,
  database_unavailable: 503,
  not_found: 404,
  conflict: 409,
  gone: 410,
  invalid: 400,
  upstream: 503,
};

export class Refusal extends Error {
  readonly code: RefusalCode;
  readonly status: RefusalStatus;

  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
    this.status = STATUS[code];
  }
}

export const isRefusal = (value: unknown): value is Refusal => value instanceof Refusal;

export const unauthenticated = (): Refusal => new Refusal('unauthenticated', 'Authentication is required.');
export const noAccess = (message: string): Refusal => new Refusal('no_access', message);
export const accountUnavailable = (message: string): Refusal => new Refusal('account_unavailable', message);
export const databaseUnavailable = (message = 'Account database is not available.'): Refusal =>
  new Refusal('database_unavailable', message);
export const notFound = (message: string): Refusal => new Refusal('not_found', message);
export const conflict = (message: string): Refusal => new Refusal('conflict', message);
export const gone = (message: string): Refusal => new Refusal('gone', message);
export const invalid = (message: string): Refusal => new Refusal('invalid', message);
/** A service this product depends on did not answer as it should. */
export const upstream = (message: string): Refusal => new Refusal('upstream', message);

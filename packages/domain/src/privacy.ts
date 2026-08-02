import type { OrganizationRole } from './index';

/**
 * Identifiers that could identify a recipient are not exposed to read-only
 * members.  The caller still receives a stable value for layout purposes
 * without leaking an email address, telephone number, or LINE destination.
 */
export const displayRecipientIdentifier = (role: OrganizationRole, value: string): string =>
  role === 'viewer' ? '***' : value;

/**
 * LINE destination IDs are routing credentials, not display data. API
 * responses expose only enough of the prefix to distinguish nearby entries.
 */
export const displayLineDestinationId = (value: string): string =>
  value.length > 5 ? `${value.slice(0, 5)}…` : value;

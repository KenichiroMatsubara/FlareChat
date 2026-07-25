import type { OrganizationRole } from './index';

/**
 * Identifiers that could identify a recipient are not exposed to read-only
 * members.  The caller still receives a stable value for layout purposes
 * without leaking an email address, telephone number, or LINE destination.
 */
export const displayRecipientIdentifier = (role: OrganizationRole, value: string): string =>
  role === 'viewer' ? '***' : value;

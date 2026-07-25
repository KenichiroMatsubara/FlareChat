# Phase 1: secure organization foundation

This delivery replaces the shared-`ORG_DB` CRUD prototype. It implements the first vertical slice from the implementation plan; it is deliberately not a public deployment or a claim that the retired dashboard is operational.

## Decisions in scope

- ADR 0037: management identities authenticate with passkeys.
- ADRs 0078 and 0084: a per-Organization encryption key protects credentials, while a versioned Worker-secret master key wraps that key; every Organization gets its own D1 database.
- ADRs 0087–0091: setup is OAuth → initial Owner passkey → idempotent provisioning, with a fifteen-minute owner-registration window and a twenty-four-hour provisioning-retry window.
- ADRs 0050, 0062, and 0088: an Automation Inbox is exclusive to one Organization, has the complete minimum grant, and starts at the Gmail history position captured during connection.

## Data ownership

Control D1 keeps only Organization routing, setup state, management identities, memberships, passkeys, sessions, and wrapped Organization keys. A newly provisioned Organization D1 stores its Automation Inbox encrypted credential and history boundary, then owns all future automation data.

The existing `ORG_DB` binding and its direct CRUD routes were removed. Until the organization-scoped management APIs are introduced, retired management routes return `410` after authentication instead of presenting a false “connected” state.

## Setup protocol

1. `POST /api/setup` creates a short-lived setup record, opaque CSRF state, and PKCE verifier encrypted under the deployment master key. The browser is redirected to Google.
2. `/oauth/google/callback` exchanges the code server-side, verifies every required scope, captures OpenID identity and the initial Gmail `historyId`, and encrypts the refresh token. Partial grants are revoked and discarded.
3. `POST /api/setup/passkey/options` and `/verify` register a user-verified ES256 passkey. The passkey is a separate Owner identity; the Automation Inbox never becomes a GUI login.
4. Provisioning creates the D1 database, applies the initial organization schema, writes the encrypted Automation Inbox connection, adds a unique Worker D1 binding, verifies the schema, and only then activates the Organization.

Cloudflare provisioning requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_WORKER_NAME` as Worker secrets. Google client credentials and `CREDENTIAL_MASTER_KEY` (base64url-encoded 32 bytes) are also Worker secrets; `CREDENTIAL_MASTER_KEY_VERSION` identifies the wrapping key. No production resource IDs or secrets are committed.

# Phase 1: secure organization foundation

This delivery replaces the shared-`ORG_DB` CRUD prototype. It implements the first vertical slice from the implementation plan; it is deliberately not a public deployment or a claim that the retired dashboard is operational.

## Decisions in scope

- ADRs 0078 and 0084: a per-Organization encryption key protects credentials, while a versioned Worker-secret master key wraps that key; every Organization gets its own D1 database.
- ADRs 0087–0091: setup is complete Google authorization → Organization-name confirmation → idempotent provisioning, with a fifteen-minute confirmation window and a twenty-four-hour provisioning-retry window.
- ADRs 0050, 0062, and 0088: an Automation Inbox is exclusive to one Organization, has the complete minimum grant, and starts at the Gmail history position captured during connection.
- ADRs 0095 and 0097: setup uses one complete Google authorization, while ordinary application login is an explicit identity-only intent and cannot enter setup.

## Data ownership

Control D1 keeps only Organization routing, OAuth flow state, setup and provisioning state, management identities, memberships, sessions, Inbox claims, and wrapped Organization keys. A newly provisioned Organization D1 stores its Automation Inbox encrypted credential and history boundary, then owns all future automation data.

The existing `ORG_DB` binding and its direct CRUD routes were removed. Until the organization-scoped management APIs are introduced, retired management routes return `410` after authentication instead of presenting a false “connected” state.

## Setup protocol

1. `POST /api/entry/google` records an explicit `login` or `organization_setup` OAuth Flow with opaque CSRF state and a PKCE verifier encrypted under the deployment master key.
2. `/oauth/google/callback` exchanges the code server-side. Login verifies the Google identity by `sub`, revokes the unused refresh token, and creates only an application session.
3. Organization setup verifies every required scope, captures OpenID identity and the initial Gmail `historyId`, encrypts the refresh token, reserves the Automation Inbox by Google `sub`, and creates a fifteen-minute setup record. Partial grants are revoked and discarded.
4. The session-authenticated `POST /api/onboarding/confirm` records the Organization name and starts provisioning. Provisioning creates the D1 database, applies the initial Organization schema, writes the encrypted Automation Inbox connection, adds a unique Worker D1 binding, verifies the schema, and only then activates the Organization.
5. `GET /api/bootstrap` derives the complete application state from the session and durable records. No setup cookie or compatibility setup route participates in recovery.

Cloudflare provisioning requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_WORKER_NAME` as Worker secrets. Google client credentials and `CREDENTIAL_MASTER_KEY` (base64url-encoded 32 bytes) are also Worker secrets; `CREDENTIAL_MASTER_KEY_VERSION` identifies the wrapping key. No production resource IDs or secrets are committed.

## Organization schema provisioning

`provisionOrganizationDatabase` allocates either a static local D1 binding or a production D1 database. Its returned `initialize()` Interface hides local database reuse, existing or partially applied tables, migration statement splitting, DDL order, and REST-versus-binding adapter differences. Initialization submits foreign-key deferral, removal of existing application tables, and the canonical Organization migration as one D1 batch. The same Interface is used by production provisioning and by the Miniflare regression test.

The deterministic regression command is:

```bash
npm run test:d1
```

It runs through the Workers Vitest pool and a real Miniflare D1 binding rather than the better-sqlite3 test adapter.

### Issue #12 diagnosis

- No Vite, Wrangler, Miniflare, or workerd development process was listening on ports 5173 or 8787 before reproduction, so a stale server was ruled out.
- Applying `migrations/organization/0000_initial.sql` as one Wrangler D1 migration to an empty database succeeded with all 38 statements. Forward foreign-key DDL order and the canonical SQL were therefore not sufficient to trigger the failure.
- Reusing a canonical-schema local D1 through the production `provisionOrganizationDatabase` Interface reproduced `D1_ERROR: no such table: main.recipient_profiles` deterministically in about three seconds.
- The bootstrap provisioning phase was `allocating_database`. The failing statement was `DROP TABLE IF EXISTS "events"` inside local database reset, before migration application.
- At failure, `sqlite_master` showed a partial reset: `recipient_profiles`, `recipient_link_tokens`, `recipient_line_destinations`, `lists`, `list_items`, `line_destinations`, `jobs`, `google_connections`, `exceptions`, `rules`, `rule_revisions`, `settings`, and `source_messages` had already been removed, while `event_recipients`, `events`, and earlier tables remained. There is intentionally no Organization `schema_migrations` table; the canonical history is the single `0000_initial.sql`.
- Root cause: reverse sequential `DROP TABLE` statements ran in separate D1 transactions with foreign-key enforcement enabled. Removing referenced tables first left dangling schema references, and a later drop caused D1 to resolve the already-removed `recipient_profiles` table.
- A partially applied or previously migrated database was required for reproduction. A truly empty database and a one-batch Wrangler migration both succeeded. Statement splitting and stale server state were ruled out; DDL order was a contributing shape, not the root cause.

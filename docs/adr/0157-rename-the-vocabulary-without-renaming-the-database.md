# Rename the vocabulary without renaming the database

The rename release changes TypeScript identifiers, types, filenames, and user-facing text only. Physical table names, column names, HTTP paths, the `schema_releases` row id, and the `flarechat-organization-` D1 name prefix all stay exactly as they are, so `accounts` is declared as `sqliteTable('organizations', …)` and `/api/organizations/:accountId` serves an Account.

ADR 0148 shipped the rename alone because ADR 0100 gates a release on a verified migration of every recorded database. Changing no schema is stronger than migrating it carefully: there is no fleet migration to verify, no window in which a production database is half-renamed, and no way for the release to lose track of a live Account. CONTEXT.md is the domain language; a table name is an implementation detail that owes it nothing.

Schema changes still come, but with the features that need them — dissolving the Admin table under ADR 0138, merging handles under ADR 0139 — where a migration is doing real work rather than restating a word.

## Consequences

Reading the storage layer means holding two names for one thing until those features land. `Membership` and `Administrator` keep their old names for the same reason: ADR 0138 deletes both, and renaming a concept on its way out is waste.

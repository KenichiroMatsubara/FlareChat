# Provision an Organization D1 database automatically

Registering an Organization starts an idempotent provisioning process that:

1. verifies the complete Automation Inbox grant required by ADR 0088;
2. verifies registration of the initial Owner passkey required by ADR 0089;
3. creates a uniquely named D1 database through the Cloudflare D1 API;
4. applies and records the current schema migration set;
5. adds a uniquely named D1 binding to the application Worker through the Cloudflare script-settings API;
6. verifies the bound database and schema; and
7. records the binding in Control D1 before marking the Organization active.

Normal application queries use the Worker D1 binding API. The Cloudflare D1 REST API is restricted to provisioning, migrations, backup, and recovery because it is a control-plane API with global rate limits.

The provisioning credential is a dedicated Worker Secret with only the Cloudflare account permissions required to edit D1 and the target Worker bindings. Provisioning states and idempotency keys live in Control D1, so retries reuse an existing database rather than creating duplicates. An Organization is never routed to an unverified or partially initialized database.

Organization provisioning and activation do not apply a deployment-wide Organization-count limit, as decided in ADR 0099.

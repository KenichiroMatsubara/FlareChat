# Provision an Organization D1 database automatically

Registering an Organization starts an idempotent provisioning process that:

1. verifies the complete Automation Inbox grant required by ADR 0088;
2. verifies registration of the initial Owner passkey required by ADR 0089;
3. derives a deterministic, human-readable database name in the form `flarechat-organization-{normalized Automation Inbox address}-{address hash}`;
4. resolves that exact name through the Cloudflare D1 API and creates it only when absent;
5. applies and records only the unapplied schema migrations without resetting existing data;
6. adds a deterministic D1 binding to the application Worker through the Cloudflare script-settings API;
7. verifies the bound database and schema; and
8. records the binding in Control D1 before marking the Organization active.

Normal application queries use the Worker D1 binding API. The Cloudflare D1 REST API is restricted to provisioning, migrations, backup, and recovery because it is a control-plane API with global rate limits.

The provisioning credential is a dedicated Worker Secret with only the Cloudflare account permissions required to edit D1 and the target Worker bindings. The deterministic Cloudflare name is the recoverable database identity. The UUID stored in Control D1 accelerates routing but is not the only way to rediscover an allocation. Retries query by exact name, refuse ambiguous duplicate matches, and reuse an existing database instead of selecting another available database or creating a replacement. An Organization is never routed to an unverified or partially initialized database.

Organization provisioning and activation do not apply a deployment-wide Organization-count limit, as decided in ADR 0099.

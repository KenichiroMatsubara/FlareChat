# Use one shared D1 without Durable Objects

Superseded by ADR 0081.

One D1 database stores all Organizations in a deployment. Every tenant-owned row carries an `organization_id`, and the data-access boundary requires an Organization scope instead of exposing unrestricted tenant tables to handlers or jobs. Cross-Organization identifiers are rejected even when a caller knows a valid object ID.

Durable Objects are not used. Concurrent cron, queue, webhook, and GUI work is coordinated with database uniqueness constraints, idempotency keys, explicit state transitions, and conditional updates. External effects retain immutable Delivery Records so a repeated invocation can observe prior success instead of sending again.

A database per Organization is rejected because Cloudflare's free-tier database-count and storage limits would place a low fixed ceiling on a multi-tenant deployment.

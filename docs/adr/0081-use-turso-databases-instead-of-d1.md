# Use Turso databases instead of D1

Superseded by ADR 0084.

Mail Automation uses no D1 database and no application-owned Durable Object. It uses one Turso control database plus one Turso domain database per Organization.

The control database contains only management identities, Organization routing, memberships, deployment-capacity state, and encrypted metadata needed to locate an Organization database. Each Organization database contains its own Automation Rules, Recipient Profiles, Scheduled Events, Attendance Registrations, connection credentials, Delivery Records, audit history, and durable Jobs.

Cloudflare Cron reads due Organization schedules and Jobs from Turso. Cloudflare Queue messages remain replaceable wake-up hints containing only an Organization identifier and Job identifier; the owning Organization database is authoritative and scheduled recovery scans rediscover lost or expired hints.

Separating Organization databases provides a stronger tenant boundary and uses Turso's larger aggregate free allowance while preserving the Cloudflare Workers, Hono, Queues, and R2 architecture. This supersedes ADRs 0005, 0068, and 0073.

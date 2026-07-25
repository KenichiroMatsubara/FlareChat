# Use Workers Paid and one D1 per Organization

Mail Automation uses the Workers Paid plan, with one Control D1 database and one Organization D1 database per Organization. Control D1 stores management identities, Organization routing, memberships, and deployment capacity state. Each Organization D1 stores only that Organization's Automation Rules, Recipient Profiles, Scheduled Events, Attendance Registrations, connection credentials, Delivery Records, audit history, and durable Jobs.

Cloudflare Cron reads due schedules and Jobs from D1. Cloudflare Queue messages remain replaceable wake-up hints containing only an Organization identifier and Job identifier; the owning Organization D1 database is authoritative and scheduled recovery scans rediscover lost or expired hints.

The deployment targets the Workers Paid minimum of approximately $5 per month under its intended small-organization workload, but accepts that Workers, D1, Queues, R2, Containers, or other metered overage may increase the bill. Application-owned Durable Objects are not used.

Database count itself does not determine D1 charges, so database-per-Organization isolation is preferred over a shared tenant database. This supersedes ADRs 0067, 0081, and 0083.

Organization databases are provisioned on demand under ADR 0087; this decision does not define a fixed database pool or slot count.

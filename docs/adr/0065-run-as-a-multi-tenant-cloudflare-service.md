# Run as a multi-tenant Cloudflare service

One Cloudflare deployment serves multiple Organizations. Every Organization D1 database, domain record, object key, queue message, credential envelope, cache key, and audit query is scoped to an Organization, while Google, LINE, and AI Connections are never reusable across tenant boundaries.

---
status: superseded in part by ADR-0095
---

# Retry failed Organization provisioning for twenty-four hours

After the complete Automation Inbox grant and initial Owner passkey registration succeed, an infrastructure failure may leave the setup in `Provisioning` for at most twenty-four hours.

During that period, Mail Automation retains the Google credential encrypted, retains the pending Owner identity in Control D1, and retries D1 resolution, migration, binding, and verification idempotently. A retry derives the same `flarechat-organization-*` name from the confirmed Automation Inbox, resolves the exact existing database even when its UUID was not persisted, applies only missing migrations, and reuses the deterministic binding.

If provisioning has not completed after twenty-four hours, Mail Automation attempts to revoke the Google grant, deletes the pending credential and Owner identity, marks any created Cloudflare resources as orphaned for operator review, and requires a new setup. It does not automatically delete an uncertain D1 database.

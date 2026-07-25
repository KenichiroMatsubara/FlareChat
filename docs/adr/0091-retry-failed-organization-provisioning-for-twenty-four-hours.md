# Retry failed Organization provisioning for twenty-four hours

After the complete Automation Inbox grant and initial Owner passkey registration succeed, an infrastructure failure may leave the setup in `Provisioning` for at most twenty-four hours.

During that period, Mail Automation retains the Google credential encrypted, retains the pending Owner identity in Control D1, and retries D1 creation, migration, binding, and verification idempotently. A retry reuses any already-created database and binding.

If provisioning has not completed after twenty-four hours, Mail Automation attempts to revoke the Google grant, deletes the pending credential and Owner identity, marks any created Cloudflare resources as orphaned for operator review, and requires a new setup. It does not automatically delete an uncertain D1 database.

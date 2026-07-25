# Require operator execution for D1 restores

An Organization Owner may request a D1 Time Travel restore, but only the deployment operator may execute it with Cloudflare recovery credentials.

The restore procedure suspends the Organization, exports the current D1 database for rollback, restores the requested point, reconciles Recovery Receipts, verifies external-effect idempotency, and only then permits resumption.

A dedicated Owner restore-request GUI is not required in the initial delivery. Until that GUI has demonstrated sufficient value, the same authorization and safety policy is implemented as a deployment-operator runbook rather than additional product surface.

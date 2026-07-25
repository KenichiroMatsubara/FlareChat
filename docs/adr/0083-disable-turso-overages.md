# Disable Turso overages

Superseded by ADR 0084.

Turso overages remain disabled. Estimated aggregate storage, monthly row reads, and monthly row writes produce one deployment warning at 80% and 95% of each free-plan allowance through the verified operations email path.

If Turso returns `BLOCKED` after an allowance is exhausted, Mail Automation treats the database operation as unavailable. It does not report a Job or external delivery as successful, and retains recoverable work as pending wherever the failed write did not commit. Processing resumes after the allowance resets or the deployment operator reduces usage.

This creates a hard no-overage boundary for Turso, unlike the warning-only R2 decision in ADR 0071.

# Archive cold history from Turso to R2

Superseded by ADR 0085.

Completed Delivery Records and audit history older than twelve months are moved from each Organization's Turso database into Organization-scoped, encrypted, compressed monthly archives in private R2 storage.

The Organization database retains compact archive indexes so the GUI can locate and retrieve older history on demand. Archival never moves active Automation Rules, Recipient Profiles, connection credentials, pending Jobs, attendance for active events, or future Scheduled Events.

An archive is verified before its source rows become eligible for deletion from Turso. This preserves long-term delivery history while conserving the aggregate Turso free-plan storage allowance. This supersedes ADR 0080.

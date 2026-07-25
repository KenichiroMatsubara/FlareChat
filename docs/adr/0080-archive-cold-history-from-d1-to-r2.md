# Archive cold history from D1 to R2

Superseded by ADR 0082.

Completed Delivery Records and audit history older than twelve months are moved from the shared D1 database into Organization-scoped, encrypted, compressed monthly archives in private R2 storage.

D1 retains compact archive indexes so the GUI can locate and retrieve older history on demand. The archive process never moves active Automation Rules, Recipient Profiles, connection credentials, pending Jobs, attendance for active events, or future Scheduled Events.

Archival protects the Workers Free per-database limit while preserving the long-term delivery and audit history required by the domain. An archive is verified before its source rows become eligible for deletion from D1.

# Archive cold history from D1 to R2

Completed Delivery Records and audit history older than twelve months are moved from each Organization D1 database into Organization-scoped, encrypted, compressed monthly archives in private R2 storage.

Organization D1 retains compact archive indexes so the GUI can locate and retrieve older history on demand. Archival never moves active Automation Rules, Recipient Profiles, connection credentials, pending Jobs, attendance for active events, or future Scheduled Events.

An archive is verified before its source rows become eligible for deletion from D1. This preserves long-term delivery history and controls D1 storage growth. This supersedes ADR 0082.

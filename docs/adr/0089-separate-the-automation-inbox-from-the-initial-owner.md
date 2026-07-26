---
status: superseded by ADR-0095
---

# Separate the Automation Inbox from the initial Owner

The Automation Inbox is an Organization-owned service connection and never acts as a human Organization member or management-GUI login.

After the complete Google grant succeeds, the person performing setup registers a passkey and becomes the initial Owner. Organization D1 provisioning begins only after both the Automation Inbox grant and initial Owner passkey registration succeed. This avoids making shared Gmail credentials the continuing authentication mechanism for administration.

The initial Owner receives the same recovery-code and membership lifecycle as later human Organization members. Revoking or replacing the Automation Inbox does not remove that Owner, and removing that Owner does not silently revoke the Organization's Google connection.

---
status: narrowed by ADR-0116
---

# Hide recipient identifiers from members

Scheduled Events hide the Google Calendar guest list from recipients. The registration page may show only the display name of a Recipient Profile that authored a Participant Comment; Member Addresses, LINE identifiers, unanswered recipients, and not-attending recipients remain visible only to Owners, Admins, and Operators.

ADR 0116 leaves an Organization one authorization role, so this rule now separates the Member Portal from the management GUI rather than one management role from another. Every management-GUI user is an Admin and sees these identifiers.

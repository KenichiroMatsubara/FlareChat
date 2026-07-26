---
status: superseded by ADR-0095
---

# Authenticate organization members with passkeys

Owners, Admins, Operators, and Viewers use passkeys as the primary management-GUI authentication with email invitations and recovery codes. Optional Google sign-in is limited to OpenID identity scopes and never grants Gmail access; only the separately authorized Automation Inbox receives Gmail, Calendar, and Drive scopes.

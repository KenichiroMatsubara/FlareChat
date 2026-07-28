# Separate application entry from Organization onboarding

Google login and Organization setup are explicit entry intents selected before Google OAuth. They share one callback but never share lifecycle state. Identity-only login requests only `openid`, `email`, and `profile`, resolves an Identity by Google `sub`, creates an application session, and cannot create or resume Organization setup. Organization setup does not pass through identity-only login: it requests the complete Automation Inbox grant and creates a short-lived `organization_setups` record only after Google returns a verified Identity, Gmail history position, and refresh credential.

The browser carries only the application session cookie; `GET /api/bootstrap` derives a discriminated App State from durable Control D1 state. Automation Inbox ownership is reserved by Google `sub` in `automation_inbox_claims`, while resumable D1 creation lives separately in `organization_provisionings`. The database is reset to this model without compatibility routes, compatibility columns, or migration of previous setup records.

The one exception is duplicate prevention at the callback boundary: when an Organization-setup intent resolves to an Identity with an active Membership, the callback revokes the broader credential and completes ordinary application login before creating any onboarding state.

# Require the complete Automation Inbox grant before Organization creation

Organization creation begins with Google OAuth authorization of the account that will become its Automation Inbox. Provisioning starts only after Google returns the complete minimum grant:

- OpenID identity (`openid`, email, and profile);
- Gmail message and attachment reading (`gmail.readonly`);
- direct email sending (`gmail.send`);
- event access on calendars owned by the account (`calendar.events.owned`); and
- access to Drive files created or opened by Mail Automation (`drive.file`).

A partial grant creates no Organization and no D1 database. Mail Automation discards the incomplete credential and attempts to revoke it before showing the missing capabilities and allowing another authorization attempt. It never substitutes `gmail.modify` or full Drive access.

The private pilot does not maintain a second application login allowlist. Its admission gate is successful authorization of the complete Automation Inbox capability set, subject to Google's unverified-app warning and OAuth user cap. This accepts that an outside Google account could deliberately pass the warning and grant the requested access; preventing that is not a private-pilot requirement.

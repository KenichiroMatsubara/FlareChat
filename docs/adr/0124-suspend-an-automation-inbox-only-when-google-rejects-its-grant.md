# Suspend an Automation Inbox only when Google rejects its grant

Automation is unattended by design: the scheduled run is the product, and the administration GUI is where an Admin goes to change something, not somewhere they have to visit for automation to keep working. A month without a sign-in is ordinary operation.

Every failed scheduled run used to suspend the Automation Inbox for reauthentication. A Gmail 5xx, a rate limit, an AI provider timeout, a network fault, or a mistyped deployment client secret each latched the connection into `reauthentication_required`, and the scheduler selects only active Inboxes — so one transient fault stopped all automation until a human signed in and reauthorized a grant that was never actually broken. The symptom read as an Automation Inbox that expires within days.

Only `invalid_grant` from Google's token endpoint means the grant itself is gone: revoked, expired, or unknown. That alone suspends the Inbox. Every other failure — including a rejected deployment client, which would otherwise suspend every Organization at once — is recorded on the connection and retried by the next scheduled run, thirty minutes later, indefinitely. The first failure of an uninterrupted run of failures is kept as the incident start and cleared by the next success.

The access token is refreshed fifteen minutes ahead of expiry rather than one. A token-endpoint outage is then ridden out on the token already held, and when a refresh token is rejected the Inbox still holds a live access token — which is what makes the notice below deliverable at all.

An Admin who is not signing in has to be told. A rejected grant is mailed to every active Admin at once through the Automation Inbox itself, because no retry can clear it. Any other failure is mailed only after a full day of failed retries, so a provider outage that resolves itself never reaches a mailbox, and it is repeated no more than weekly while it persists. A notice that could not be sent is left unrecorded so a later run tries again.

Mailing through the Automation Inbox keeps one Organization's operational notice inside that Organization's own credential, as ADR 0072 requires of the separate deployment-level capacity path. It also bounds what is reportable: an Admin who revokes the grant in their Google account revokes its access token with it, and that one case is visible only in the GUI.

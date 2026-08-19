# Allow an Account more than one identity

An Account may bind more than one Google identity, each with the same complete authority. ADR 0095 made the Google account that authorized the Automation Inbox the sole login, which was survivable while Admins could be added later; ADR 0138 removed that role, so losing that one Google account now means permanently losing the Account and everything in its database, with no operator path back because ADR 0094's restore has to be requested by someone who can still sign in.

This does not reintroduce a role. ADR 0138 deleted an authorization role, not a credential, and every bound identity holds identical authority, so no permission model appears. It restores what ADR 0089 wanted before ADR 0095 folded it away — that a shared mailbox credential should not be the only continuing means of authentication — without restoring passkeys.

## Consequences

A second identity can only be bound by an existing one, so it is useless unless bound before the first is lost. Setup must therefore press for a second identity rather than offer it.

---
status: superseded by ADR-0139
---

# Authenticate Members with identity-only Google login

A Member signs in through the identity-only Google grant of ADR 0095 and reaches one Member Portal carrying both attendance registration and their Tasks. A Member is bound to a Google account once, by opening a single-use link delivered to their linked LINE Destination, after which that account's stable `sub` identifies them; the roster address is not used for this, because it need not be a Google account. This supersedes ADR 0038 and revises the "neither application credentials nor Google OAuth" clause of ADRs 0024 and 0025.

Completing a Task is an authenticated act rather than a link-bearing one, and running attendance registration on an unguessable URL while running Tasks on a login would have left one person with two ways to prove who they are. Members with no linked LINE Destination cannot reach the Portal and are administered entirely by an Admin; no alternative delivery is provided.

## Consequences

A leaked URL no longer grants attendance changes on someone else's behalf. A Member may read every Task in the Organization but may complete only their own, and an unfinished Task approaching its deadline notifies its assignee on the ADR 0030 principle of reminding only those who have not yet acted.

The lifetime user cap of ADR 0077 is not consumed by Member sign-in, because that cap counts only grants of unapproved sensitive or restricted scopes and the Portal requests none. The cap therefore continues to bound the number of Organizations, not the number of people.

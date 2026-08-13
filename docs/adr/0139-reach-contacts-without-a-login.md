# Reach Contacts without a login

A Contact is an addressable entity and nothing more: it carries a name, tags, and one or more Channel Handles, and it may be a person, a group, a room, or a channel. It never signs in. The Member's three conflated roles are separated — addressability stays on the Contact, work assignment becomes a reference to a Contact, and the login is deleted rather than rehoused.

The pages a Contact reaches — attendance registration, comments, its own Tasks — are entered only through the revocable, single-use, time-limited link of ADR 0038. ADR 0119's identity-only Google login for Members is retired, and with it the product's second authentication system. Granting a Contact a login would immediately require a rule for what that login may see, which is the authorization role ADR 0138 just deleted, arriving from the other side.

## Consequences

Member Address and LINE Destination both dissolve into Channel Handles, so a Contact reachable on several channels is one row rather than a person joined to a separate destination table. Anyone holding an unexpired link acts as that Contact; revocation, single use, and expiry are the whole mitigation.

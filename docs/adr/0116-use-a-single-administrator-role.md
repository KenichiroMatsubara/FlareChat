# Use a single administrator role

An Organization has one authorization role, Admin, instead of Owner, Admin, Operator, and Viewer. The four-role split assumed administration divided among several people, but ADR 0095 made the Automation Inbox and the sole administrator the same shared Organization account, so every role check resolved to the same identity while the codebase carried forty-two authorization branches to distinguish them. This supersedes ADR 0015 and narrows ADR 0046 to Admins.

No second Admin is provided. The initial Admin is the Organization's own shared account rather than a person, so it survives officer turnover without a handover mechanism, and the `pending` membership state is removed rather than implemented. If a second Admin is ever wanted it is promoted from a Member, whose Google account is already bound by ADR 0119, rather than invited by address.

## Consequences

The deployment operator of ADR 0094 runs the service itself, is not an Organization role, and is unaffected by this decision despite the similar name.
